import type { BrowserWorker } from "@cloudflare/playwright";
import {
  THREADS_ALLOWED_DOMAINS,
  createCloudflareReadonlyBrowser,
  createCloudflareReadonlyPage,
  type CloudflareBrowserLike,
  type CloudflareContextLike,
  type CloudflarePageLike,
} from "./cloudflare-adapter.js";
import {
  MAX_RUN_DURATION_MS,
  isAllowedNavigationUrl,
  runScout as runScoutCore,
  type ReadonlyBrowserAdapter,
  type ScoutRunConfig,
  type ScoutRunResult,
} from "./runner.js";
import { decryptStorageState, encryptStorageState } from "./state-crypto.js";
import {
  ScoutCoordinator,
  type BootstrapSession,
  type CoordinatedBootstrapResult,
  type CoordinatedRunResult,
  type CoordinatorStorage,
} from "./coordinator.js";

export const CLOUDFLARE_RUN_DURATION_MS = 9 * 60 * 1000;
const VERSION = "0.1.0";
const BOOTSTRAP_TTL_SECONDS = 600;
const MAX_REQUEST_BODY_BYTES = 1_024;
const MAX_RESULTS = 7;
const COORDINATOR_NAME = "threads-patrol-scout";
const CLEANUP_TIMEOUT_MS = 1_000;
const RUN_CLEANUP_RESERVE_MS = 5_000;
const BOOTSTRAP_COMMIT_DURATION_MS = 60_000;
const STATE_CAPTURE_TIMEOUT_MS = 5_000;
const ISO_ALPHA_2_CODES = new Set(`
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ
VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW
`.trim().split(/\s+/));

interface BrowserTarget {
  id: string;
  type?: string;
  url?: string;
}

interface BrowserBinding {
  acquire(options?: {
    keepAlive?: number;
    recording?: boolean;
    location?: string;
    guardrails?: { allowedDomains: string[] };
    targets?: boolean;
  }): Promise<{ sessionId: string; targets?: BrowserTarget[] }>;
  getLiveView(sessionId: string, options: {
    targetId: string;
    mode: "tab";
    expiresInMs: number;
  }): Promise<{ devtoolsFrontendUrl: string }>;
  closeSession(sessionId: string): Promise<{ status: "closing" | "closed" }>;
  getSession?(sessionId: string): Promise<{ closeReasonText?: string } | null>;
  devtools: {
    newTarget(sessionId: string, url: string): Promise<BrowserTarget>;
  };
}

interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface ScoutEnv {
  BROWSER: BrowserBinding;
  SCOUT_ADMIN_TOKEN: string;
  SCOUT_STATE_KEY_B64: string;
  SCOUT_INGEST_URL?: string;
  SCOUT_INGEST_TOKEN?: string;
  PATROL_WORKBENCH?: { fetch(request: Request): Promise<Response> };
  OWN_HANDLE?: string;
  SCOUT_BROWSER_LOCATION?: string;
  SCOUT_COORDINATOR?: DurableObjectNamespaceLike;
}

interface WorkerContextLike extends CloudflareContextLike {
  pages(): CloudflarePageLike[];
  storageState(options?: { indexedDB?: boolean }): Promise<object>;
}

interface WorkerBrowserLike extends CloudflareBrowserLike {
  contexts(): WorkerContextLike[];
  newContext(options?: { storageState?: object }): Promise<WorkerContextLike>;
}

export interface SpikeMetric {
  timestamp: string;
  status: "completed" | "stopped";
  stopReason?: string;
  candidateCount: number;
  durationMs: number;
  sessionCloseReason?: string;
  failureStage?: "state" | "acquire" | "connect" | "feed" | "capture" | "ingestion";
  ingestionHttpStatus?: number;
  extractedCount?: number;
  deliveredCount?: number;
  discovery?: {seenCount:number;scrollCount:number;refreshCount:number};
  ingestionStep?: "configuration" | "request" | "fetch" | "acknowledgement";
  failureCode?: "RATE_LIMIT" | "QUOTA" | "SERVICE_UNAVAILABLE";
}

export interface WorkerDependencies {
  connectBrowser?: (binding: BrowserBinding, sessionId: string) => Promise<WorkerBrowserLike>;
  runScout?: (
    browser: ReadonlyBrowserAdapter,
    config: ScoutRunConfig,
  ) => Promise<ScoutRunResult>;
  now?: () => Date;
  coordinator?: ScoutCoordinator;
  operationBudgetMs?: number;
  bootstrapCommitBudgetMs?: number;
}

interface ScheduledControllerLike {
  scheduledTime: number;
  cron: string;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: RESPONSE_HEADERS,
  });
}

function errorResponse(status: number, code: string): Response {
  return json({ error: code }, status);
}

async function digestToken(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function secureTokenEqual(candidate: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([digestToken(candidate), digestToken(expected)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return candidate.length > 0 && expected.length > 0 && difference === 0;
}

async function isAuthorized(request: Request, env: ScoutEnv): Promise<boolean> {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return secureTokenEqual(match?.[1] ?? "", env.SCOUT_ADMIN_TOKEN);
}

type JsonBodyResult = { body: Record<string, unknown>; error?: never } | { error: Response; body?: never };

async function readJsonBody(request: Request): Promise<JsonBodyResult> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return { error: errorResponse(415, "JSON_REQUIRED") };
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && !/^\d+$/.test(contentLength)) {
    return { error: errorResponse(400, "INVALID_CONTENT_LENGTH") };
  }
  if (contentLength !== null && Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
    return { error: errorResponse(413, "BODY_TOO_LARGE") };
  }
  const reader = request.body?.getReader();
  if (!reader) return { error: errorResponse(400, "INVALID_JSON_BODY") };
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel("body too large").catch(() => undefined);
        return { error: errorResponse(413, "BODY_TOO_LARGE") };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: errorResponse(400, "INVALID_JSON_BODY") };
    }
    return { body: parsed as Record<string, unknown> };
  } catch {
    return { error: errorResponse(400, "INVALID_JSON_BODY") };
  }
}

export function hasThreadsAuthenticatedState(storageStateJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(storageStateJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const cookies = Reflect.get(parsed, "cookies");
    if (!Array.isArray(cookies)) return false;
    return cookies.some((cookie: unknown) => {
      if (typeof cookie !== "object" || cookie === null || Array.isArray(cookie)) return false;
      const name = Reflect.get(cookie, "name");
      const value = Reflect.get(cookie, "value");
      const domain = Reflect.get(cookie, "domain");
      return name === "sessionid" &&
        typeof value === "string" && value.length > 0 &&
        typeof domain === "string" &&
        /^(?:instagram\.com|threads\.(?:com|net))$/i.test(domain.replace(/^\./, ""));
    });
  } catch {
    return false;
  }
}

function configuredBrowserLocation(env: ScoutEnv): string | undefined {
  const location = env.SCOUT_BROWSER_LOCATION;
  if (location === undefined) return undefined;
  if (!ISO_ALPHA_2_CODES.has(location)) {
    throw new Error("Invalid browser location configuration");
  }
  return location;
}

async function defaultConnectBrowser(
  binding: BrowserBinding,
  sessionId: string,
): Promise<WorkerBrowserLike> {
  const { connect, endpointURLString } = await import("@cloudflare/playwright");
  // Bootstrap Live View uses the browser's default context. Persistent CDP
  // attachment is required for Playwright to expose that existing context.
  const endpoint = new URL(endpointURLString(binding as unknown as BrowserWorker, { sessionId }));
  endpoint.searchParams.set("persistent", "true");
  const browser = await connect(endpoint.toString());
  return browser as unknown as WorkerBrowserLike;
}

async function closeSession(
  env: ScoutEnv,
  sessionId: string,
): Promise<string | undefined> {
  try {
    await env.BROWSER.closeSession(sessionId);
  } catch {
    return undefined;
  }
  try {
    return (await env.BROWSER.getSession?.(sessionId))?.closeReasonText;
  } catch {
    return undefined;
  }
}

function gateSummary(metrics: readonly SpikeMetric[]): {
  decision: "PENDING" | "APPROVED" | "BLOCKED";
  completedCount: number;
  manualLoginInterruptions: number;
  warnings: string[];
  stopReasons: string[];
  medianDurationMs: number | null;
  readOnly: true;
  interactionOccurred: false;
} {
  const completedCount = metrics.filter((metric) => metric.status === "completed").length;
  const stopReasons = metrics.flatMap((metric) => metric.stopReason ? [metric.stopReason] : []);
  const manualReasons = new Set(["LOGIN_PROMPT", "CHECKPOINT", "CAPTCHA", "CHALLENGE"]);
  const warningReasons = new Set([
    "HTTP_429",
    "NAVIGATION_BLOCKED",
    "UNEXPECTED_CONSENT",
    "CAPTCHA",
    "CHALLENGE",
    "CHECKPOINT",
  ]);
  const manualLoginInterruptions = stopReasons.filter((reason) => manualReasons.has(reason)).length;
  const warnings = [...new Set(stopReasons.filter((reason) => warningReasons.has(reason)))];
  const durations = metrics.map((metric) => metric.durationMs).sort((left, right) => left - right);
  const midpoint = Math.floor(durations.length / 2);
  const medianDurationMs = durations.length === 0
    ? null
    : durations.length % 2 === 0
      ? (durations[midpoint - 1]! + durations[midpoint]!) / 2
      : durations[midpoint]!;
  const decision = metrics.length < MAX_RESULTS
    ? "PENDING"
    : completedCount >= 6 && manualLoginInterruptions === 0 && warnings.length === 0
      ? "APPROVED"
      : "BLOCKED";
  return {
    decision,
    completedCount,
    manualLoginInterruptions,
    warnings,
    stopReasons,
    medianDurationMs,
    readOnly: true,
    interactionOccurred: false,
  };
}

interface ExecutionDependencies {
  connectBrowser: NonNullable<WorkerDependencies["connectBrowser"]>;
  runScout: NonNullable<WorkerDependencies["runScout"]>;
  now: NonNullable<WorkerDependencies["now"]>;
  operationBudgetMs: number;
}

class OperationDeadlineError extends Error {}

async function withinDeadline<T>(operation: Promise<T>, deadlineMs: number): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw new OperationDeadlineError("Operation deadline exceeded");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new OperationDeadlineError("Operation deadline exceeded")),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function executeScoutRun(
  env: ScoutEnv,
  dependencies: ExecutionDependencies,
  encryptedState: string | undefined,
  seenUrls:readonly string[] = [],
): Promise<CoordinatedRunResult> {
  const { connectBrowser, runScout, now } = dependencies;
  const absoluteEndAt = Date.now() + dependencies.operationBudgetMs;
  const cleanupReserveMs = cleanupReserveForBudget(dependencies.operationBudgetMs);
  const mainEndAt = absoluteEndAt - cleanupReserveMs;
  const startedAt = now().getTime();
  const timestamp = now().toISOString();
  if (!encryptedState) {
    return { metric: {
      timestamp,
      status: "stopped",
      stopReason: "NO_STORAGE_STATE",
      candidateCount: 0,
      durationMs: Math.max(0, now().getTime() - startedAt),
    } };
  }

  let sessionId: string | undefined;
  let browser: WorkerBrowserLike | undefined;
  let metric: SpikeMetric | undefined;
  let failureStage: NonNullable<SpikeMetric["failureStage"]> = "state";
  let ingestionHttpStatus: number | undefined;
  let extractedCount = 0;
  let ingestionStep: SpikeMetric['ingestionStep'];
  const deliveredUrls:string[]=[];
  let discovery:SpikeMetric['discovery'];
  try {
    const storageStateJson = await withinDeadline(
      decryptStorageState(encryptedState, env.SCOUT_STATE_KEY_B64),
      mainEndAt,
    );
    const storageState = JSON.parse(storageStateJson) as object;
    const location = configuredBrowserLocation(env);
    failureStage = "acquire";
    const acquirePromise = env.BROWSER.acquire({
      keepAlive: CLOUDFLARE_RUN_DURATION_MS + 30_000,
      recording: false,
      ...(location === undefined ? {} : { location }),
      guardrails: { allowedDomains: [...THREADS_ALLOWED_DOMAINS] },
    });
    let acquired: Awaited<typeof acquirePromise>;
    try {
      acquired = await withinDeadline(acquirePromise, mainEndAt);
    } catch (error) {
      void acquirePromise.then((lateSession) => withCleanupTimeout(
        closeSession(env, lateSession.sessionId),
      )).catch(() => undefined);
      throw error;
    }
    sessionId = acquired.sessionId;
    failureStage = "connect";
    const connectPromise = connectBrowser(env.BROWSER, sessionId);
    try {
      browser = await withinDeadline(connectPromise, mainEndAt);
    } catch (error) {
      void connectPromise.then((lateBrowser) => withCleanupTimeout(
        Promise.resolve().then(() => lateBrowser.close()),
      )).catch(() => undefined);
      throw error;
    }
    const context = await withinDeadline(browser.newContext({ storageState }), mainEndAt);
    let capturedState: string | undefined;
    const capturingBrowser: CloudflareBrowserLike = {
      newContext: () => Promise.resolve(context),
      close: async () => {
        capturedState = JSON.stringify(await context.storageState({ indexedDB: true }));
        await browser?.close();
      },
    };
    const adapter = createCloudflareReadonlyBrowser(capturingBrowser, context);
    const remainingRunMs = mainEndAt - Date.now() - Math.min(RUN_CLEANUP_RESERVE_MS, cleanupReserveMs);
    if (remainingRunMs <= 0) throw new OperationDeadlineError("Operation deadline exceeded");
    failureStage = "feed";
    const result = await withinDeadline(runScout(adapter, {
      targetUrl: "https://www.threads.com/",
      ownHandle: env.OWN_HANDLE?.trim() || "bfh9023",
      excludedHandles: ['bfh9023', 'best_forest_house'],
      seenUrls,
      maxCandidates:120,
      minLikes:1001,
      timeWindowMs: 48 * 60 * 60 * 1_000,
      maxDurationMs: Math.min(CLOUDFLARE_RUN_DURATION_MS, remainingRunMs),
      now: now(),
    }), mainEndAt);
    extractedCount = result.candidates.length;
    if(result.status==='completed')discovery=result.discovery;
    if (result.status === "completed" && !capturedState) {
      failureStage = "capture";
      capturedState = JSON.stringify(await withinDeadline(
        context.storageState({ indexedDB: true }),
        Math.min(mainEndAt, Date.now() + STATE_CAPTURE_TIMEOUT_MS),
      ));
    }
    if (result.status === "completed" && result.candidates.length > 0) {
      failureStage = "ingestion";
      ingestionStep = "configuration";
      const destination = new URL(env.SCOUT_INGEST_URL || "");
      if (
        destination.href !== "https://threads-patrol-workbench.kobeyoga.workers.dev/api/ingest" ||
        !env.SCOUT_INGEST_TOKEN
      ) throw new Error("Invalid ingestion configuration");
      const ingestionAbort = new AbortController();
      const ingestionEndAt = Math.min(mainEndAt, Date.now() + 15_000);
      const timer = setTimeout(() => ingestionAbort.abort(), Math.max(1, ingestionEndAt - Date.now()));
      try {
        for(let offset=0;offset<result.candidates.length;offset+=40){
        const batch=result.candidates.slice(offset,offset+40);
        ingestionStep = "request";
        const requestOptions: RequestInit = {
          method: "POST",
          // Workers rejects Request.redirect="error"; manual never forwards bearer to redirects.
          redirect: "manual",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.SCOUT_INGEST_TOKEN}` },
          signal: ingestionAbort.signal,
          body: JSON.stringify({ candidates: batch.map(candidate => ({
            sourcePostId: candidate.sourcePostId,
            sourceUrl: candidate.sourceUrl,
            author: candidate.authorHandle,
            text: candidate.text,
            observedAt: candidate.discoveredAt,
            publicMetrics: candidate.visibleMetrics,
          })) }),
        };
        const serviceRequest = env.PATROL_WORKBENCH ? new Request(destination, requestOptions) : undefined;
        ingestionStep = "fetch";
        const response = await withinDeadline(
          env.PATROL_WORKBENCH
            ? env.PATROL_WORKBENCH.fetch(serviceRequest!)
            : fetch(destination, requestOptions),
          ingestionEndAt,
        );
        ingestionHttpStatus = response.status;
        ingestionStep = "acknowledgement";
        if (!response.ok) throw new Error("Ingestion failed");
        deliveredUrls.push(...batch.map(candidate=>candidate.sourceUrl));
        await withinDeadline(Promise.resolve(response.body?.cancel()), ingestionEndAt);
        }
      } finally {
        clearTimeout(timer);
        ingestionAbort.abort();
      }
    }
    metric = result.status === "completed"
      ? {
          timestamp,
          status: "completed",
          candidateCount: result.candidates.length,
          extractedCount,
          deliveredCount:deliveredUrls.length,
          ...(discovery?{discovery}:{}),
          durationMs: Math.max(0, now().getTime() - startedAt),
        }
      : {
          timestamp,
          status: "stopped",
          stopReason: result.reason,
          candidateCount: 0,
          durationMs: Math.max(0, now().getTime() - startedAt),
        };
    const nextEncryptedState = result.status === "completed" && capturedState
      ? await withinDeadline(
          encryptStorageState(capturedState, env.SCOUT_STATE_KEY_B64),
          mainEndAt,
        )
      : encryptedState;
    return { metric, encryptedState: nextEncryptedState,deliveredUrls };
  } catch (error) {
    metric = {
      timestamp,
      status: "stopped",
      stopReason: "RUN_ERROR",
      failureStage,
      ...(failureStage === "acquire" ? { failureCode: /rate.?limit|429/i.test(String(error)) ? "RATE_LIMIT" as const : /quota|daily|limit exceeded/i.test(String(error)) ? "QUOTA" as const : "SERVICE_UNAVAILABLE" as const } : {}),
      ...(ingestionHttpStatus === undefined ? {} : { ingestionHttpStatus }),
      extractedCount,
      deliveredCount:deliveredUrls.length,
      ...(discovery?{discovery}:{}),
      ...(failureStage === "ingestion" ? { ingestionStep } : {}),
      candidateCount: 0,
      durationMs: Math.max(0, now().getTime() - startedAt),
    };
  } finally {
    const [browserCleanup, sessionCleanup] = await Promise.allSettled([
      withCleanupUntil(Promise.resolve().then(() => browser?.close()), absoluteEndAt),
      sessionId
        ? withCleanupUntil(closeSession(env, sessionId), absoluteEndAt)
        : Promise.resolve(undefined),
    ]);
    void browserCleanup;
    if (sessionCleanup.status === "fulfilled" && sessionCleanup.value && metric) {
      metric.sessionCloseReason = String(sessionCleanup.value);
    }
  }
  return { metric: metric!, encryptedState,deliveredUrls };
}

type BootstrapCommitValue = { saved: true } | {
  error: "UNSAFE_BOOTSTRAP_STATE";
  reason: "NO_CONTEXT" | "NO_ALLOWED_PAGE" | "CHECKPOINT" | "CAPTCHA" | "CHALLENGE" | "CONSENT" | "NO_AUTHENTICATED_STATE";
};

async function executeBootstrapCommit(
  env: ScoutEnv,
  connectBrowser: ExecutionDependencies["connectBrowser"],
  metadata: BootstrapSession,
  budgetMs = BOOTSTRAP_COMMIT_DURATION_MS,
): Promise<CoordinatedBootstrapResult<BootstrapCommitValue>> {
  const absoluteEndAt = Date.now() + budgetMs;
  const mainEndAt = absoluteEndAt - cleanupReserveForBudget(budgetMs);
  let browser: WorkerBrowserLike | undefined;
  try {
    const connectPromise = connectBrowser(env.BROWSER, metadata.sessionId);
    try {
      browser = await withinDeadline(connectPromise, mainEndAt);
    } catch (error) {
      void connectPromise.then((lateBrowser) => withCleanupTimeout(
        Promise.resolve().then(() => lateBrowser.close()),
      )).catch(() => undefined);
      throw error;
    }
    const context = browser.contexts()[0];
    const page = context?.pages().find((candidate) => isAllowedNavigationUrl(candidate.url()));
    if (!context || !page) return { value: {
      error: "UNSAFE_BOOTSTRAP_STATE",
      reason: !context ? "NO_CONTEXT" : "NO_ALLOWED_PAGE",
    } };
    const controller = new AbortController();
    const safety = await withinDeadline(createCloudflareReadonlyPage(page).getSafetyState({
      deadlineMs: Date.now() + 30_000,
      signal: controller.signal,
    }), mainEndAt);
    const storageState = JSON.stringify(await withinDeadline(
      context.storageState({ indexedDB: true }),
      Math.min(mainEndAt, Date.now() + STATE_CAPTURE_TIMEOUT_MS),
    ));
    const authenticated = hasThreadsAuthenticatedState(storageState);
    if (
      safety.checkpoint || safety.captcha || safety.challenge || safety.unexpectedConsent ||
      !authenticated
    ) {
      return { value: {
        error: "UNSAFE_BOOTSTRAP_STATE",
        reason: safety.checkpoint ? "CHECKPOINT" :
          safety.captcha ? "CAPTCHA" :
          safety.challenge ? "CHALLENGE" :
          safety.unexpectedConsent ? "CONSENT" : "NO_AUTHENTICATED_STATE",
      } };
    }
    return {
      value: { saved: true },
      encryptedState: await withinDeadline(
        encryptStorageState(storageState, env.SCOUT_STATE_KEY_B64),
        mainEndAt,
      ),
    };
  } finally {
    await Promise.allSettled([
      withCleanupUntil(Promise.resolve().then(() => browser?.close()), absoluteEndAt),
      withCleanupUntil(closeSession(env, metadata.sessionId), absoluteEndAt),
    ]);
  }
}

function coordinatorStub(env: ScoutEnv): DurableObjectStubLike {
  if (!env.SCOUT_COORDINATOR) throw new Error("Coordinator binding is not configured");
  return env.SCOUT_COORDINATOR.get(env.SCOUT_COORDINATOR.idFromName(COORDINATOR_NAME));
}

async function callCoordinator<T>(
  env: ScoutEnv,
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const response = await coordinatorStub(env).fetch(new Request(`https://coordinator.internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  if (!response.ok) throw new Error("Coordinator request failed");
  return response.json() as Promise<T>;
}

async function withCleanupTimeout(operation: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Cleanup timed out")), CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function cleanupReserveForBudget(budgetMs: number): number {
  return Math.min(RUN_CLEANUP_RESERVE_MS, Math.max(1, Math.floor(budgetMs / 10)));
}

export async function withCleanupUntil(operation: Promise<unknown>, absoluteEndAt: number): Promise<unknown> {
  const remainingMs = Math.min(CLEANUP_TIMEOUT_MS, absoluteEndAt - Date.now());
  if (remainingMs <= 0) {
    void operation.catch(() => undefined);
    throw new OperationDeadlineError("Cleanup deadline exceeded");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new OperationDeadlineError("Cleanup deadline exceeded")),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createCloudflareWorker(dependencies: WorkerDependencies = {}) {
  const connectBrowser = dependencies.connectBrowser ?? defaultConnectBrowser;
  const runScout = dependencies.runScout ?? runScoutCore;
  const now = dependencies.now ?? (() => new Date());
  const operationBudgetMs = dependencies.operationBudgetMs ?? CLOUDFLARE_RUN_DURATION_MS;
  const bootstrapCommitBudgetMs = dependencies.bootstrapCommitBudgetMs ?? BOOTSTRAP_COMMIT_DURATION_MS;
  if (
    !Number.isInteger(operationBudgetMs) || operationBudgetMs <= 10 ||
    operationBudgetMs > CLOUDFLARE_RUN_DURATION_MS ||
    !Number.isInteger(bootstrapCommitBudgetMs) || bootstrapCommitBudgetMs <= 0 ||
    bootstrapCommitBudgetMs > BOOTSTRAP_TTL_SECONDS * 1_000
  ) throw new Error("Invalid worker operation budget");
  const executionDependencies = { connectBrowser, runScout, now, operationBudgetMs };
  const localCoordinator = dependencies.coordinator;

  async function storeBootstrap(env: ScoutEnv, bootstrapId: string, session: BootstrapSession): Promise<void> {
    if (localCoordinator) return localCoordinator.storeBootstrap(bootstrapId, session);
    await callCoordinator(env, "/bootstrap/store", { bootstrapId, session });
  }

  async function cleanupExpiredBootstraps(env: ScoutEnv): Promise<void> {
    const expired = localCoordinator
      ? await localCoordinator.takeExpiredBootstraps(now().getTime())
      : await callCoordinator<BootstrapSession[]>(env, "/bootstrap/expired", { nowMs: now().getTime() });
    await Promise.allSettled(expired.map((session) => withCleanupTimeout(
      closeSession(env, session.sessionId),
    )));
  }

  async function coordinatedRun(env: ScoutEnv, requestId: string): Promise<SpikeMetric> {
    if (localCoordinator) {
      return localCoordinator.runOnce(
        requestId,
        (encryptedState,seenUrls) => executeScoutRun(env, executionDependencies, encryptedState,seenUrls),
      );
    }
    return callCoordinator(env, "/run", { requestId });
  }

  async function getMetrics(env: ScoutEnv): Promise<SpikeMetric[]> {
    if (localCoordinator) return localCoordinator.getMetrics();
    return callCoordinator(env, "/metrics");
  }

  async function bootstrapStart(env: ScoutEnv): Promise<Response> {
    await cleanupExpiredBootstraps(env);
    const location = configuredBrowserLocation(env);
    const acquired = await env.BROWSER.acquire({
      keepAlive: BOOTSTRAP_TTL_SECONDS * 1_000,
      recording: true,
      ...(location === undefined ? {} : { location }),
      guardrails: { allowedDomains: [...THREADS_ALLOWED_DOMAINS] },
      targets: true,
    });
    try {
      const target = await env.BROWSER.devtools.newTarget(
        acquired.sessionId,
        "https://www.threads.com/",
      );
      const liveView = await env.BROWSER.getLiveView(acquired.sessionId, {
        targetId: target.id,
        mode: "tab",
        expiresInMs: BOOTSTRAP_TTL_SECONDS * 1_000,
      });
      const expiresAt = now().getTime() + BOOTSTRAP_TTL_SECONDS * 1_000;
      const bootstrapId = crypto.randomUUID();
      await storeBootstrap(env, bootstrapId, { sessionId: acquired.sessionId, expiresAt });
      return json({
        bootstrapId,
        liveViewUrl: liveView.devtoolsFrontendUrl,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    } catch (error) {
      await closeSession(env, acquired.sessionId);
      throw error;
    }
  }

  async function bootstrapCommit(env: ScoutEnv, bootstrapId: string): Promise<Response> {
    await cleanupExpiredBootstraps(env);
    const result = localCoordinator
      ? await localCoordinator.commitBootstrap(
          bootstrapId,
          now().getTime(),
          (metadata) => executeBootstrapCommit(env, connectBrowser, metadata, bootstrapCommitBudgetMs),
        )
      : await callCoordinator<BootstrapCommitValue | null>(env, "/bootstrap/commit", {
          bootstrapId,
          nowMs: now().getTime(),
        });
    if (!result) return errorResponse(409, "NO_ACTIVE_BOOTSTRAP");
    if ("error" in result) return json(result, 409);
    return json(result);
  }

  async function routeRequest(request: Request, env: ScoutEnv): Promise<Response> {
    configuredBrowserLocation(env);
    const url = new URL(request.url);
    if (url.pathname === "/internal/status") {
      if (request.method !== "GET") return errorResponse(405,"METHOD_NOT_ALLOWED");
      if (!env.SCOUT_INGEST_TOKEN || !await secureTokenEqual(request.headers.get("Authorization") || "",`Bearer ${env.SCOUT_INGEST_TOKEN}`)) return errorResponse(401,"UNAUTHORIZED");
      const metrics=await getMetrics(env);
      return json({latest:metrics.at(-1) || null,scheduleTaipei:["08:30","12:30","17:30","22:00"],validation:"pending-seven-scheduled-runs"});
    }
    if (url.pathname === "/health") {
      if (request.method !== "GET") return errorResponse(405, "METHOD_NOT_ALLOWED");
      return json({
        service: "threads-patrol-scout",
        version: VERSION,
        authConfigured: env.SCOUT_ADMIN_TOKEN.length > 0,
      });
    }

    if (!url.pathname.startsWith("/admin/")) return errorResponse(404, "NOT_FOUND");
    if (!await isAuthorized(request, env)) return errorResponse(401, "UNAUTHORIZED");

    if (url.pathname === "/admin/spike-results") {
      if (request.method !== "GET") return errorResponse(405, "METHOD_NOT_ALLOWED");
      const metrics = await getMetrics(env);
      return json({ metrics, gate: gateSummary(metrics) });
    }

    if (request.method !== "POST") return errorResponse(405, "METHOD_NOT_ALLOWED");
    const parsedBody = await readJsonBody(request);
    if (parsedBody.error) return parsedBody.error;
    if (url.pathname === "/admin/bootstrap/start") return bootstrapStart(env);
    if (url.pathname === "/admin/bootstrap/commit") {
      const bootstrapId = parsedBody.body.bootstrapId;
      if (typeof bootstrapId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bootstrapId)) {
        return errorResponse(400, "INVALID_BOOTSTRAP_ID");
      }
      return bootstrapCommit(env, bootstrapId);
    }
    if (url.pathname === "/admin/run-once") {
      const suppliedId = parsedBody.body.requestId;
      if (
        typeof suppliedId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedId)
      ) {
        return errorResponse(400, "INVALID_REQUEST_ID");
      }
      await cleanupExpiredBootstraps(env);
      const requestId = `manual:${suppliedId}`;
      return json(await coordinatedRun(env, requestId));
    }
    return errorResponse(404, "NOT_FOUND");
  }

  async function fetch(request: Request, env: ScoutEnv): Promise<Response> {
    try {
      return await routeRequest(request, env);
    } catch {
      return errorResponse(500, "INTERNAL_ERROR");
    }
  }

  return {
    fetch,
    async scheduled(
      event: ScheduledControllerLike,
      env: ScoutEnv,
      _ctx: ExecutionContextLike,
    ): Promise<void> {
      // Consolidate cron registrations while preserving the four approved Taipei windows.
      const scheduledAt = new Date(event.scheduledTime);
      const hour = scheduledAt.getUTCHours();
      const minute = scheduledAt.getUTCMinutes();
      if (!((hour === 14 && minute === 0) || ([0, 4, 9].includes(hour) && minute === 30))) return;
      configuredBrowserLocation(env);
      await cleanupExpiredBootstraps(env);
      await coordinatedRun(env, `scheduled:${Math.floor(event.scheduledTime / 60_000)}`);
    },
  };
}

export class ScoutCoordinatorDurableObject {
  private readonly coordinator: ScoutCoordinator;

  constructor(state: { storage: CoordinatorStorage }, private readonly env: ScoutEnv) {
    this.coordinator = new ScoutCoordinator(state.storage);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") return errorResponse(405, "METHOD_NOT_ALLOWED");
      const parsed = await readJsonBody(request);
      if (parsed.error) return parsed.error;
      const path = new URL(request.url).pathname;
      if (path === "/run") {
        const requestId = parsed.body.requestId;
        if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 200) {
          return errorResponse(400, "INVALID_REQUEST_ID");
        }
        return json(await this.coordinator.runOnce(requestId, (encryptedState,seenUrls) => executeScoutRun(
          this.env,
          {
            connectBrowser: defaultConnectBrowser,
            runScout: runScoutCore,
            now: () => new Date(),
            operationBudgetMs: CLOUDFLARE_RUN_DURATION_MS,
          },
          encryptedState,
          seenUrls,
        )));
      }
      if (path === "/metrics") return json(await this.coordinator.getMetrics());
      if (path === "/bootstrap/store") {
        const bootstrapId = parsed.body.bootstrapId;
        const session = parsed.body.session;
        if (
          typeof bootstrapId !== "string" ||
          typeof session !== "object" ||
          session === null ||
          typeof Reflect.get(session, "sessionId") !== "string" ||
          !Number.isFinite(Reflect.get(session, "expiresAt"))
        ) return errorResponse(400, "INVALID_BOOTSTRAP");
        await this.coordinator.storeBootstrap(bootstrapId, {
          sessionId: String(Reflect.get(session, "sessionId")),
          expiresAt: Number(Reflect.get(session, "expiresAt")),
        });
        return json({ stored: true });
      }
      if (path === "/bootstrap/claim") {
        const bootstrapId = parsed.body.bootstrapId;
        const nowMs = parsed.body.nowMs;
        if (typeof bootstrapId !== "string" || !Number.isFinite(nowMs)) {
          return errorResponse(400, "INVALID_BOOTSTRAP");
        }
        return json(await this.coordinator.claimBootstrap(bootstrapId, Number(nowMs)));
      }
      if (path === "/bootstrap/commit") {
        const bootstrapId = parsed.body.bootstrapId;
        const nowMs = parsed.body.nowMs;
        if (typeof bootstrapId !== "string" || !Number.isFinite(nowMs)) {
          return errorResponse(400, "INVALID_BOOTSTRAP");
        }
        return json(await this.coordinator.commitBootstrap(
          bootstrapId,
          Number(nowMs),
          (metadata) => executeBootstrapCommit(this.env, defaultConnectBrowser, metadata),
        ));
      }
      if (path === "/bootstrap/delete") {
        if (typeof parsed.body.bootstrapId !== "string") return errorResponse(400, "INVALID_BOOTSTRAP");
        await this.coordinator.deleteBootstrap(parsed.body.bootstrapId);
        return json({ deleted: true });
      }
      if (path === "/bootstrap/expired") {
        if (!Number.isFinite(parsed.body.nowMs)) return errorResponse(400, "INVALID_TIME");
        return json(await this.coordinator.takeExpiredBootstraps(Number(parsed.body.nowMs)));
      }
      return errorResponse(404, "NOT_FOUND");
    } catch {
      return errorResponse(500, "INTERNAL_ERROR");
    }
  }
}

export default createCloudflareWorker();
