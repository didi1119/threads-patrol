import { describe, expect, it, vi } from "vitest";
import {
  ScoutCoordinator,
  type BootstrapSession,
  type CoordinatorStorage,
} from "./coordinator.js";
import type { SpikeMetric } from "./cloudflare-worker.js";

class MemoryStorage implements CoordinatorStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    return new Map([...this.values.entries()]
      .filter(([key]) => key.startsWith(options.prefix)) as [string, T][]);
  }

  async transaction<T>(callback: (storage: CoordinatorStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

function metric(timestamp: string, durationMs = 100): SpikeMetric {
  return { timestamp, status: "completed", candidateCount: 0, durationMs };
}

describe("ScoutCoordinator", () => {
  it('persists only delivered URLs and supplies them across coordinator restarts',async()=>{
    const storage=new MemoryStorage();const first=new ScoutCoordinator(storage);
    await first.runOnce('one',async()=>({metric:metric('2026-10-02T12:00:00Z'),deliveredUrls:['https://threads.com/@a/post/P1']}));
    const second=new ScoutCoordinator(storage);let seen:readonly string[]=[];
    await second.runOnce('two',async(_state,urls)=>{seen=urls;return metric('2026-10-02T12:05:00Z');});
    expect(seen).toEqual(['https://threads.com/@a/post/P1']);
  });
  it("deduplicates concurrent and replayed runs with the same request id", async () => {
    const coordinator = new ScoutCoordinator(new MemoryStorage());
    let release!: (value: SpikeMetric) => void;
    const deferred = new Promise<SpikeMetric>((resolve) => { release = resolve; });
    const operation = vi.fn(() => deferred);

    const first = coordinator.runOnce("manual:11111111-1111-4111-8111-111111111111", operation);
    const second = coordinator.runOnce("manual:11111111-1111-4111-8111-111111111111", operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    release(metric("2026-09-28T12:00:00.000Z"));
    await expect(Promise.all([first, second])).resolves.toEqual([
      metric("2026-09-28T12:00:00.000Z"),
      metric("2026-09-28T12:00:00.000Z"),
    ]);

    await expect(coordinator.runOnce(
      "manual:11111111-1111-4111-8111-111111111111",
      operation,
    )).resolves.toEqual(metric("2026-09-28T12:00:00.000Z"));
    expect(operation).toHaveBeenCalledOnce();
    expect(await coordinator.getMetrics()).toHaveLength(1);
  });

  it("serializes different run ids and retains the newest seven metrics", async () => {
    const coordinator = new ScoutCoordinator(new MemoryStorage());
    let active = 0;
    let maxActive = 0;
    const operations = Array.from({ length: 8 }, (_, index) => coordinator.runOnce(
      `scheduled:${index}:cron`,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return metric(new Date(index * 1_000).toISOString(), index);
      },
    ));
    await Promise.all(operations);

    expect(maxActive).toBe(1);
    expect((await coordinator.getMetrics()).map((entry) => entry.durationMs)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("claims bootstrap ids once without affecting another bootstrap", async () => {
    const coordinator = new ScoutCoordinator(new MemoryStorage());
    const sessionA: BootstrapSession = { sessionId: "session-a", expiresAt: 2_000 };
    const sessionB: BootstrapSession = { sessionId: "session-b", expiresAt: 2_000 };
    await coordinator.storeBootstrap("a", sessionA);
    await coordinator.storeBootstrap("b", sessionB);

    await expect(coordinator.claimBootstrap("a", 1_000)).resolves.toEqual(sessionA);
    await expect(coordinator.claimBootstrap("a", 1_000)).resolves.toBeNull();
    await expect(coordinator.claimBootstrap("b", 1_000)).resolves.toEqual(sessionB);
  });

  it("returns expired sessions for cleanup and prevents committing them", async () => {
    const coordinator = new ScoutCoordinator(new MemoryStorage());
    const expired = { sessionId: "expired", expiresAt: 999 };
    await coordinator.storeBootstrap("old", expired);

    await expect(coordinator.takeExpiredBootstraps(1_000)).resolves.toEqual([expired]);
    await expect(coordinator.claimBootstrap("old", 1_000)).resolves.toBeNull();
  });

  it("serializes bootstrap state commit before a run reads state", async () => {
    const coordinator = new ScoutCoordinator(new MemoryStorage());
    await coordinator.storeBootstrap("bootstrap", { sessionId: "session", expiresAt: 2_000 });
    await coordinator.storeEncryptedState("old-state");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const commit = coordinator.commitBootstrap("bootstrap", 1_000, async () => {
      await blocked;
      return { value: { saved: true }, encryptedState: "new-state" };
    });
    const operation = vi.fn(async (encryptedState: string | undefined) => ({
      metric: metric("2026-09-28T12:00:00.000Z"),
      encryptedState,
    }));
    const run = coordinator.runOnce("manual:state", operation);

    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    release();
    await expect(commit).resolves.toEqual({ saved: true });
    await expect(run).resolves.toEqual(metric("2026-09-28T12:00:00.000Z"));
    expect(operation).toHaveBeenCalledWith("new-state",[]);
    await expect(coordinator.readEncryptedState()).resolves.toBe("new-state");
  });
});
