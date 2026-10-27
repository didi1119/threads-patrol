import type { SpikeMetric } from "./cloudflare-worker.js";

const METRICS_KEY = "metrics:v1";
const LEDGER_KEY = "run-ledger:v1";
const BOOTSTRAP_PREFIX = "bootstrap:v1:";
const ENCRYPTED_STATE_KEY = "encrypted-storage-state:v1";
const DELIVERED_URLS_KEY='delivered-urls:v1';
const MAX_METRICS = 7;
const MAX_LEDGER_ENTRIES = 64;

export interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  transaction<T>(callback: (storage: CoordinatorStorage) => Promise<T>): Promise<T>;
}

export interface BootstrapSession {
  sessionId: string;
  expiresAt: number;
}

interface StoredBootstrapSession extends BootstrapSession {
  claimed: boolean;
}

interface LedgerEntry {
  id: string;
  metric: SpikeMetric;
}

export interface CoordinatedRunResult {
  metric: SpikeMetric;
  encryptedState?: string;
  deliveredUrls?: string[];
}

export interface CoordinatedBootstrapResult<T> {
  value: T;
  encryptedState?: string;
}

export class ScoutCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<SpikeMetric>>();

  constructor(private readonly storage: CoordinatorStorage) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  runOnce(
    requestId: string,
    operation: (encryptedState: string | undefined, seenUrls:readonly string[]) => Promise<CoordinatedRunResult | SpikeMetric>,
  ): Promise<SpikeMetric> {
    const existing = this.inFlight.get(requestId);
    if (existing) return existing;
    const running = this.enqueue(async () => {
      const ledger = await this.storage.get<LedgerEntry[]>(LEDGER_KEY) ?? [];
      const recorded = ledger.find((entry) => entry.id === requestId);
      if (recorded) return recorded.metric;

      const encryptedState = await this.storage.get<string>(ENCRYPTED_STATE_KEY);
      const seenUrls=await this.storage.get<string[]>(DELIVERED_URLS_KEY)??[];
      const execution = await operation(encryptedState,seenUrls);
      const result = "metric" in execution ? execution : { metric: execution };
      const { metric } = result;
      await this.storage.transaction(async (transaction) => {
        const currentLedger = await transaction.get<LedgerEntry[]>(LEDGER_KEY) ?? [];
        const currentMetrics = await transaction.get<SpikeMetric[]>(METRICS_KEY) ?? [];
        await transaction.put(LEDGER_KEY, [
          ...currentLedger.filter((entry) => entry.id !== requestId),
          { id: requestId, metric },
        ].slice(-MAX_LEDGER_ENTRIES));
        await transaction.put(METRICS_KEY, [...currentMetrics, metric].slice(-MAX_METRICS));
        if(result.deliveredUrls?.length){
          const existing=await transaction.get<string[]>(DELIVERED_URLS_KEY)??[];
          await transaction.put(DELIVERED_URLS_KEY,[...new Set([...existing,...result.deliveredUrls])].slice(-1000));
        }
        if (result.encryptedState !== undefined) {
          await transaction.put(ENCRYPTED_STATE_KEY, result.encryptedState);
        }
      });
      return metric;
    });
    this.inFlight.set(requestId, running);
    void running.finally(() => {
      if (this.inFlight.get(requestId) === running) this.inFlight.delete(requestId);
    }).catch(() => undefined);
    return running;
  }

  storeEncryptedState(encryptedState: string): Promise<void> {
    return this.enqueue(() => this.storage.put(ENCRYPTED_STATE_KEY, encryptedState));
  }

  readEncryptedState(): Promise<string | undefined> {
    return this.enqueue(() => this.storage.get<string>(ENCRYPTED_STATE_KEY));
  }

  commitBootstrap<T>(
    bootstrapId: string,
    nowMs: number,
    operation: (session: BootstrapSession) => Promise<CoordinatedBootstrapResult<T>>,
  ): Promise<T | null> {
    return this.enqueue(async () => {
      const key = `${BOOTSTRAP_PREFIX}${bootstrapId}`;
      const session = await this.storage.get<StoredBootstrapSession>(key);
      if (!session || session.claimed || session.expiresAt <= nowMs) {
        if (session?.expiresAt !== undefined && session.expiresAt <= nowMs) {
          await this.storage.delete(key).catch(() => undefined);
        }
        return null;
      }
      await this.storage.put(key, { ...session, claimed: true });
      try {
        const result = await operation({ sessionId: session.sessionId, expiresAt: session.expiresAt });
        if (result.encryptedState !== undefined) {
          await this.storage.transaction(async (transaction) => {
            await transaction.put(ENCRYPTED_STATE_KEY, result.encryptedState!);
          });
        }
        return result.value;
      } finally {
        await this.storage.delete(key).catch(() => undefined);
      }
    });
  }

  getMetrics(): Promise<SpikeMetric[]> {
    return this.enqueue(async () => [...(await this.storage.get<SpikeMetric[]>(METRICS_KEY) ?? [])]);
  }

  storeBootstrap(bootstrapId: string, session: BootstrapSession): Promise<void> {
    return this.enqueue(() => this.storage.put(`${BOOTSTRAP_PREFIX}${bootstrapId}`, {
      ...session,
      claimed: false,
    } satisfies StoredBootstrapSession));
  }

  claimBootstrap(bootstrapId: string, nowMs: number): Promise<BootstrapSession | null> {
    return this.enqueue(async () => {
      const key = `${BOOTSTRAP_PREFIX}${bootstrapId}`;
      const session = await this.storage.get<StoredBootstrapSession>(key);
      if (!session || session.claimed) return null;
      if (session.expiresAt <= nowMs) {
        await this.storage.delete(key);
        return null;
      }
      await this.storage.put(key, { ...session, claimed: true });
      return { sessionId: session.sessionId, expiresAt: session.expiresAt };
    });
  }

  deleteBootstrap(bootstrapId: string): Promise<void> {
    return this.enqueue(async () => { await this.storage.delete(`${BOOTSTRAP_PREFIX}${bootstrapId}`); });
  }

  takeExpiredBootstraps(nowMs: number): Promise<BootstrapSession[]> {
    return this.enqueue(async () => {
      const sessions = await this.storage.list<StoredBootstrapSession>({ prefix: BOOTSTRAP_PREFIX });
      const expired: BootstrapSession[] = [];
      for (const [key, session] of sessions) {
        if (session.expiresAt <= nowMs) {
          expired.push({ sessionId: session.sessionId, expiresAt: session.expiresAt });
          await this.storage.delete(key).catch(() => undefined);
        }
      }
      return expired;
    });
  }
}
