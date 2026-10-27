import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadonlyBrowserAdapter, ScoutRunConfig, ScoutRunResult } from "./runner.js";
import { decryptStorageState, encryptStorageState } from "./state-crypto.js";
import { ScoutCoordinator, type CoordinatorStorage } from "./coordinator.js";
import {
  CLOUDFLARE_RUN_DURATION_MS,
  createCloudflareWorker,
  hasThreadsAuthenticatedState,
  secureTokenEqual,
  withCleanupUntil,
  type ScoutEnv,
  type SpikeMetric,
} from "./cloudflare-worker.js";

const adminToken = "admin-secret-token";
const encryptionKey = Buffer.alloc(32, 4).toString("base64");
afterEach(() => vi.unstubAllGlobals());
const initialState = JSON.stringify({ cookies: [], origins: [] });
const updatedState = JSON.stringify({
  cookies: [{ name: "sessionid", value: "new-secret", domain: ".instagram.com", path: "/" }],
  origins: [],
});

class MemoryCoordinatorStorage implements CoordinatorStorage {
  readonly values = new Map<string, unknown>();
  failDelete = false;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    if (this.failDelete && key.startsWith("bootstrap:")) throw new Error("delete secret failure");
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

function makeRawBrowser(storageState = updatedState) {
  const page = {
    route: vi.fn(async () => undefined),
    goto: vi.fn(async () => ({ status: () => 200, url: () => "https://www.threads.com/" })),
    url: vi.fn(() => "https://www.threads.com/"),
    evaluate: vi.fn(async (_fn: unknown, argument: unknown) =>
      typeof argument === "number" ? "<html></html>" : {},
    ),
    close: vi.fn(async () => undefined),
  };
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
    storageState: vi.fn(async () => JSON.parse(storageState) as object),
  };
  const browser = {
    contexts: vi.fn(() => [context]),
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
  return { browser, context, page };
}

function setup(options: {
  operationBudgetMs?: number;
  bootstrapCommitBudgetMs?: number;
  browserLocation?: string;
} = {}) {
  const { browserLocation, ...workerOptions } = options;
  const coordinatorStorage = new MemoryCoordinatorStorage();
  const coordinator = new ScoutCoordinator(coordinatorStorage);
  const target = { id: "target-1", type: "page", url: "https://www.threads.com/" };
  const binding = {
    acquire: vi.fn(async (_options?: Record<string, unknown>) => ({ sessionId: "session-1", targets: [target] })),
    getLiveView: vi.fn(async () => ({ devtoolsFrontendUrl: "https://live.browser.run/private-token" })),
    closeSession: vi.fn(async () => ({ status: "closed" as const })),
    getSession: vi.fn(async () => ({ closeReasonText: "Normal closure" })),
    devtools: {
      newTarget: vi.fn(async () => target),
    },
  };
  const raw = makeRawBrowser();
  const connectBrowser = vi.fn(async () => raw.browser);
  const runScout = vi.fn(async (_browser: ReadonlyBrowserAdapter, _config: ScoutRunConfig): Promise<ScoutRunResult> => ({
    status: "completed" as const,
    candidates: [{
      sourcePostId: "1",
      sourceUrl: "https://www.threads.com/@a/post/1",
      authorHandle: "a",
      text: "visible",
      discoveredAt: "2026-09-28T12:00:00.000Z",
      visibleMetrics: { likes: 0, replies: 0 },
    }],
  }));
  const env: ScoutEnv = {
    BROWSER: binding,
    SCOUT_ADMIN_TOKEN: adminToken,
    SCOUT_STATE_KEY_B64: encryptionKey,
    SCOUT_INGEST_URL: 'https://threads-patrol-workbench.kobeyoga.workers.dev/api/ingest',
    SCOUT_INGEST_TOKEN: 'ingestion-secret',
    OWN_HANDLE: "bfh9023",
    ...(browserLocation === undefined ? {} : { SCOUT_BROWSER_LOCATION: browserLocation }),
  };
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}',{status:200})));
  const worker = createCloudflareWorker({
    connectBrowser,
    runScout,
    now: () => new Date("2026-09-28T12:00:00.000Z"),
    coordinator,
    ...workerOptions,
  });
  return { coordinator, coordinatorStorage, binding, raw, connectBrowser, runScout, env, worker };
}

function request(path: string, options: { token?: string; method?: string; body?: string } = {}): Request {
  const headers = new Headers();
  if (options.token !== undefined) headers.set("Authorization", `Bearer ${options.token}`);
  if ((options.method ?? "GET") === "POST") headers.set("Content-Type", "application/json");
  return new Request(`https://scout.example${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ?? ((options.method ?? "GET") === "POST"
      ? path === "/admin/run-once"
        ? JSON.stringify({ requestId: crypto.randomUUID() })
        : "{}"
      : undefined),
  });
}

function streamingRequest(
  path: string,
  chunks: readonly string[],
  contentLength?: string,
): { request: Request; cancel: ReturnType<typeof vi.fn> } {
  const encoded = chunks.map((chunk) => new TextEncoder().encode(chunk));
  let index = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = encoded[index++];
      if (chunk) controller.enqueue(chunk);
      if (index >= encoded.length && encoded.reduce((total, value) => total + value.byteLength, 0) <= 1_024) {
        controller.close();
      }
    },
    cancel,
  });
  const headers = new Headers({
    Authorization: `Bearer ${adminToken}`,
    "Content-Type": "application/json",
  });
  if (contentLength !== undefined) headers.set("Content-Length", contentLength);
  return {
    request: new Request(`https://scout.example${path}`, {
      method: "POST",
      headers,
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
    cancel,
  };
}

describe("admin authentication", () => {
  it("compares equal and unequal tokens without a length shortcut", async () => {
    await expect(secureTokenEqual("same", "same")).resolves.toBe(true);
    await expect(secureTokenEqual("same", "different-and-longer")).resolves.toBe(false);
    await expect(secureTokenEqual("", "")).resolves.toBe(false);
  });

  it.each([undefined, "wrong", "admin-secret-token-extra"])("rejects token %s", async (token) => {
    const { worker, env } = setup();
    const response = await worker.fetch(request("/admin/spike-results", { token }), env);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain(adminToken);
  });
});

describe("absolute cleanup deadline", () => {
  it("observes a late cleanup rejection after the deadline", async () => {
    let rejectCleanup!: (error: Error) => void;
    const cleanup = new Promise<never>((_resolve, reject) => { rejectCleanup = reject; });

    await expect(withCleanupUntil(cleanup, Date.now() - 1)).rejects.toThrow("deadline");
    rejectCleanup(new Error("late cleanup failure"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
});

describe("worker routes", () => {
  it('exposes safe scout health only to the machine credential',async()=>{
    const {worker,env,coordinator,binding}=setup();
    await coordinator.storeEncryptedState(await encryptStorageState(initialState,encryptionKey));
    binding.acquire.mockRejectedValueOnce(new Error('rate limit exceeded secret-cookie-placeholder'));
    await worker.fetch(request('/admin/run-once',{method:'POST',token:adminToken}),env);
    expect((await worker.fetch(request('/internal/status'),env)).status).toBe(401);
    const response=await worker.fetch(request('/internal/status',{token:'ingestion-secret'}),env);
    expect(await response.json()).toMatchObject({latest:{failureCode:'RATE_LIMIT'},scheduleTaipei:['08:30','12:30','17:30','22:00']});
  });
  it('uses a private service binding instead of public worker-to-worker fetch',async()=>{
    const {worker,env,coordinator}=setup();
    await coordinator.storeEncryptedState(await encryptStorageState(initialState,encryptionKey));
    const serviceFetch=vi.fn(async(_request:Request)=>new Response('{}',{status:200}));
    (env as ScoutEnv & {PATROL_WORKBENCH:unknown}).PATROL_WORKBENCH={fetch:serviceFetch};
    const publicFetch=vi.fn(()=>{throw new Error('Public worker route unavailable');});
    vi.stubGlobal('fetch',publicFetch);
    const response=await worker.fetch(request('/admin/run-once',{method:'POST',token:adminToken}),env);
    expect(await response.json()).toMatchObject({status:'completed',candidateCount:1});
    expect(serviceFetch).toHaveBeenCalledOnce();
    const forwarded=serviceFetch.mock.calls[0]![0];
    expect(forwarded.url).toBe(env.SCOUT_INGEST_URL);
    expect(forwarded.headers.get('Authorization')).toBe('Bearer ingestion-secret');
    expect(publicFetch).not.toHaveBeenCalled();
  });
  it("fails closed and closes the browser when ingestion configuration is missing", async () => {
    const { worker, env, coordinator, binding, raw } = setup();
    delete env.SCOUT_INGEST_URL;
    await coordinator.storeEncryptedState(await encryptStorageState(initialState, encryptionKey));
    const response = await worker.fetch(request('/admin/run-once', { method:'POST', token:adminToken }), env);
    expect(await response.json()).toMatchObject({status:'stopped',stopReason:'RUN_ERROR'});
    expect(binding.closeSession).toHaveBeenCalled();
    expect(raw.browser.close).toHaveBeenCalled();
  });

  it("bounds stalled ingestion cancellation by the main deadline and still closes", async () => {
    const { worker, env, coordinator, binding } = setup({operationBudgetMs:150});
    env.SCOUT_INGEST_URL='https://threads-patrol-workbench.kobeyoga.workers.dev/api/ingest';
    env.SCOUT_INGEST_TOKEN='ingestion-secret';
    await coordinator.storeEncryptedState(await encryptStorageState(initialState, encryptionKey));
    vi.stubGlobal('fetch', vi.fn(async()=>({ok:true,body:{cancel:()=>new Promise(()=>{})}})));
    const response=await worker.fetch(request('/admin/run-once',{method:'POST',token:adminToken}),env);
    expect(await response.json()).toMatchObject({status:'stopped',stopReason:'RUN_ERROR'});
    expect(binding.closeSession).toHaveBeenCalled();
  },2000);
  it("sends real candidates only to the configured private ingestion destination", async () => {
    const { worker, env, coordinator } = setup();
    env.SCOUT_INGEST_URL = 'https://threads-patrol-workbench.kobeyoga.workers.dev/api/ingest';
    env.SCOUT_INGEST_TOKEN = 'ingestion-secret';
    await coordinator.storeEncryptedState(await encryptStorageState(initialState, encryptionKey));
    const mockedFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status:200 }));
    vi.stubGlobal('fetch', mockedFetch);
    try {
      const response = await worker.fetch(request('/admin/run-once', { method:'POST', token:adminToken }), env);
      expect(await response.json()).toMatchObject({ status:'completed', candidateCount:1 });
      expect(mockedFetch).toHaveBeenCalledOnce();
      const options = mockedFetch.mock.calls[0]?.[1] as unknown as RequestInit;
      expect(options.redirect).toBe('manual');
      expect(JSON.parse(String(options.body))).toMatchObject({ candidates:[{ sourcePostId:'1', text:'visible', publicMetrics:{ likes:0, replies:0 } }] });
    } finally { vi.unstubAllGlobals(); }
  });

  it("does not transmit candidates to an unapproved host", async () => {
    const { worker, env, coordinator } = setup();
    env.SCOUT_INGEST_URL = 'https://example.com/api/ingest';
    env.SCOUT_INGEST_TOKEN = 'ingestion-secret';
    await coordinator.storeEncryptedState(await encryptStorageState(initialState, encryptionKey));
    const mockedFetch = vi.fn();
    vi.stubGlobal('fetch', mockedFetch);
    try {
      const response = await worker.fetch(request('/admin/run-once', { method:'POST', token:adminToken }), env);
      expect(await response.json()).toMatchObject({ status:'stopped', stopReason:'RUN_ERROR' });
      expect(mockedFetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("records an ingestion HTTP failure and cleans up the browser", async () => {
    const {worker,env,coordinator,binding}=setup();
    await coordinator.storeEncryptedState(await encryptStorageState(initialState,encryptionKey));
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('unavailable',{status:503})));
    const response=await worker.fetch(request('/admin/run-once',{method:'POST',token:adminToken}),env);
    expect(await response.json()).toMatchObject({status:'stopped',stopReason:'RUN_ERROR',candidateCount:0});
    expect(binding.closeSession).toHaveBeenCalledOnce();
  });

  it('preserves extracted count and safe ingestion boundary on transport failure',async()=>{
    const {worker,env,coordinator}=setup();
    await coordinator.storeEncryptedState(await encryptStorageState(initialState,encryptionKey));
    env.PATROL_WORKBENCH={fetch:async()=>{throw new Error('transport secret-token');}};
    const response=await worker.fetch(request('/admin/run-once',{method:'POST',token:adminToken}),env);
    const body=await response.json();
    expect(body).toMatchObject({status:'stopped',failureStage:'ingestion',ingestionStep:'fetch',extractedCount:1,candidateCount:0});
    expect(JSON.stringify(body)).not.toContain('secret-token');
  });
  it('delivers deep batches under 40 and passes successful URLs to the next run',async()=>{
    const {worker,env,coordinator,runScout}=setup();
    await coordinator.storeEncryptedState(await encryptStorageState(initialState,encryptionKey));
    runScout.mockResolvedValueOnce({status:'completed',candidates:Array.from({length:120},(_,i)=>({sourcePostId:String(i),sourceUrl:`https://www.threads.com/@a/post/${i}`,authorHandle:'a',text:'日常',discoveredAt:'2026-09-28T12:00:00Z',visibleMetrics:{likes:0,replies:0}}))});
    const sizes:number[]=[];env.PATROL_WORKBENCH={fetch:async r=>{sizes.push((await r.json() as {candidates:unknown[]}).candidates.length);return Response.json({ok:true});}};
    const result=await worker.fetch(request('/admin/run-once',{method:'POST',token:adminToken}),env);
    expect(await result.json()).toMatchObject({status:'completed',extractedCount:120,deliveredCount:120});
    expect(sizes).toEqual([40,40,40]);
    runScout.mockResolvedValueOnce({status:'completed',candidates:[]});
    await worker.fetch(request('/admin/run-once',{method:'POST',token:adminToken}),env);
    expect(runScout.mock.calls[1]![1].seenUrls).toHaveLength(120);
  });
  it('rejects a redirect without sending credentials to the destination',async()=>{
    const {worker,env,coordinator}=setup();
    await coordinator.storeEncryptedState(await encryptStorageState(initialState,encryptionKey));
    const call=vi.fn(async(r:Request)=>{expect(r.redirect).toBe('manual');return new Response(null,{status:302,headers:{Location:'https://evil.example'}});});env.PATROL_WORKBENCH={fetch:call};
    const response=await worker.fetch(request('/admin/run-once',{method:'POST',token:adminToken}),env);
    expect(await response.json()).toMatchObject({status:'stopped',ingestionHttpStatus:302,deliveredCount:0});expect(call).toHaveBeenCalledOnce();
  });

  it("recognizes only a non-empty Meta session cookie as authenticated state", () => {
    expect(hasThreadsAuthenticatedState(updatedState)).toBe(true);
    expect(hasThreadsAuthenticatedState(initialState)).toBe(false);
    expect(hasThreadsAuthenticatedState(JSON.stringify({
      cookies: [{ name: "sessionid", value: "", domain: ".instagram.com", path: "/" }],
      origins: [],
    }))).toBe(false);
    expect(hasThreadsAuthenticatedState(JSON.stringify({
      cookies: [{ name: "sessionid", value: "secret", domain: ".example.com", path: "/" }],
      origins: [],
    }))).toBe(false);
    expect(hasThreadsAuthenticatedState(JSON.stringify({
      cookies: [{ name: "sessionid", value: "legacy-secret", domain: ".threads.net", path: "/" }],
      origins: [],
    }))).toBe(true);
  });

  it("keeps health public and reveals only configuration status", async () => {
    const { worker, env } = setup();
    const response = await worker.fetch(request("/health"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "threads-patrol-scout",
      version: "0.1.0",
      authConfigured: true,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires JSON and rejects oversized request bodies", async () => {
    const { worker, env } = setup();
    const missingType = new Request("https://scout.example/admin/run-once", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect((await worker.fetch(missingType, env)).status).toBe(415);
    expect((await worker.fetch(request("/admin/run-once", {
      method: "POST",
      token: adminToken,
      body: JSON.stringify({ padding: "x".repeat(2_000) }),
    }), env)).status).toBe(413);
  });

  it("accepts a bounded JSON stream without Content-Length", async () => {
    const { worker, env } = setup();
    const streamed = streamingRequest("/admin/run-once", [
      '{"requestId":"11111111-1111-4111-8111-111111111111"}',
    ]);
    expect((await worker.fetch(streamed.request, env)).status).toBe(200);
    expect(streamed.cancel).not.toHaveBeenCalled();
  });

  it("requires a retry-safe manual request id", async () => {
    const { worker, env } = setup();
    const response = await worker.fetch(request("/admin/run-once", {
      method: "POST",
      token: adminToken,
      body: "{}",
    }), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_REQUEST_ID" });
  });

  it("rejects a declared oversized body before consuming JSON", async () => {
    const { worker, env } = setup();
    const streamed = streamingRequest("/admin/run-once", ["{}"], "2048");
    const response = await worker.fetch(streamed.request, env);
    expect(response.status).toBe(413);
  });

  it("cancels a chunked body as soon as it exceeds the streaming limit", async () => {
    const { worker, env } = setup();
    const streamed = streamingRequest("/admin/run-once", ["x".repeat(700), "y".repeat(700)]);
    const response = await worker.fetch(streamed.request, env);
    expect(response.status).toBe(413);
    expect(streamed.cancel).toHaveBeenCalledOnce();
  });

  it("rejects a body that exceeds a falsified small Content-Length", async () => {
    const { worker, env } = setup();
    const streamed = streamingRequest("/admin/run-once", ["x".repeat(700), "y".repeat(700)], "2");
    const response = await worker.fetch(streamed.request, env);
    expect(response.status).toBe(413);
    expect(streamed.cancel).toHaveBeenCalledOnce();
  });

  it("sanitizes unexpected route failures and preserves security headers", async () => {
    const { worker, env, binding } = setup();
    binding.acquire.mockRejectedValueOnce(new Error(`failure ${adminToken}`));
    const response = await worker.fetch(request("/admin/bootstrap/start", {
      method: "POST",
      token: adminToken,
    }), env);
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe('{"error":"INTERNAL_ERROR"}');
  });

  it("starts a guarded bootstrap and never persists or logs its Live View URL", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { worker, env, coordinatorStorage, binding } = setup();
    const response = await worker.fetch(request("/admin/bootstrap/start", {
      method: "POST",
      token: adminToken,
    }), env);
    const payload = await response.json() as { bootstrapId: string; liveViewUrl: string; expiresAt: string };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload.liveViewUrl).toBe("https://live.browser.run/private-token");
    expect(payload.bootstrapId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Date.parse(payload.expiresAt)).toBe(Date.parse("2026-09-28T12:00:00.000Z") + 600_000);
    expect(binding.acquire).toHaveBeenCalledWith(expect.objectContaining({
      recording: true,
      keepAlive: 600_000,
      guardrails: { allowedDomains: expect.arrayContaining(["threads.com", "*.threads.com"]) },
    }));
    expect(binding.acquire.mock.calls[0]?.[0]).not.toHaveProperty("location");
    expect(binding.getLiveView).toHaveBeenCalledWith("session-1", {
      targetId: "target-1",
      mode: "tab",
      expiresInMs: 600_000,
    });
    expect(JSON.stringify([...coordinatorStorage.values.values()])).not.toContain("live.browser.run");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("commits only a safe Threads tab and stores encrypted state", async () => {
    const { worker, env, coordinator, binding, raw } = setup();
    raw.context.pages.mockReturnValueOnce([
      { ...raw.page, url: vi.fn(() => "about:blank") },
      raw.page,
    ]);
    const started = await worker.fetch(request("/admin/bootstrap/start", {
      method: "POST",
      token: adminToken,
    }), env);
    const { bootstrapId } = await started.json() as { bootstrapId: string };

    const response = await worker.fetch(request("/admin/bootstrap/commit", {
      method: "POST",
      token: adminToken,
      body: JSON.stringify({ bootstrapId }),
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true });
    const encrypted = await coordinator.readEncryptedState();
    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toContain("new-secret");
    await expect(decryptStorageState(encrypted!, encryptionKey)).resolves.toBe(updatedState);
    expect(binding.closeSession).toHaveBeenCalledWith("session-1");
  });

  it("keeps concurrent bootstrap sessions independent and rejects commit replay", async () => {
    const setupValue = setup();
    setupValue.binding.acquire
      .mockResolvedValueOnce({ sessionId: "session-a", targets: [] })
      .mockResolvedValueOnce({ sessionId: "session-b", targets: [] });
    const start = async () => {
      const response = await setupValue.worker.fetch(request("/admin/bootstrap/start", {
        method: "POST",
        token: adminToken,
      }), setupValue.env);
      return response.json() as Promise<{ bootstrapId: string }>;
    };
    const a = await start();
    const b = await start();

    const commitA = () => setupValue.worker.fetch(request("/admin/bootstrap/commit", {
      method: "POST",
      token: adminToken,
      body: JSON.stringify({ bootstrapId: a.bootstrapId }),
    }), setupValue.env);
    expect((await commitA()).status).toBe(200);
    expect((await commitA()).status).toBe(409);
    expect(setupValue.connectBrowser).toHaveBeenCalledOnce();
    await expect(setupValue.coordinator.claimBootstrap(b.bootstrapId, Date.parse("2026-09-28T12:00:00.000Z")))
      .resolves.toMatchObject({ sessionId: "session-b" });
  });

  it("attempts browser and session cleanup even when bootstrap metadata deletion fails", async () => {
    const setupValue = setup();
    const started = await setupValue.worker.fetch(request("/admin/bootstrap/start", {
      method: "POST",
      token: adminToken,
    }), setupValue.env);
    const { bootstrapId } = await started.json() as { bootstrapId: string };
    setupValue.coordinatorStorage.failDelete = true;

    const response = await setupValue.worker.fetch(request("/admin/bootstrap/commit", {
      method: "POST",
      token: adminToken,
      body: JSON.stringify({ bootstrapId }),
    }), setupValue.env);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("delete secret failure");
    expect(setupValue.raw.browser.close).toHaveBeenCalled();
    expect(setupValue.binding.closeSession).toHaveBeenCalledWith("session-1");
  });

  it("updates encrypted state only after a safe completed run", async () => {
    const { worker, env, coordinator, binding, runScout } = setup();
    await coordinator.storeEncryptedState(await encryptStorageState(initialState, encryptionKey));
    const before = await coordinator.readEncryptedState();
    const response = await worker.fetch(request("/admin/run-once", {
      method: "POST",
      token: adminToken,
    }), env);
    const metric = await response.json() as SpikeMetric;

    expect(metric).toMatchObject({ status: "completed", candidateCount: 1 });
    const runConfig = runScout.mock.calls[0]?.[1];
    expect(runConfig?.maxDurationMs).toBeGreaterThan(0);
    expect(runConfig?.maxDurationMs).toBeLessThan(CLOUDFLARE_RUN_DURATION_MS);
    expect(CLOUDFLARE_RUN_DURATION_MS).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(binding.acquire).toHaveBeenCalledWith(expect.objectContaining({ recording: false }));
    expect(binding.acquire.mock.calls[0]?.[0]).not.toHaveProperty("location");
    expect(metric).not.toHaveProperty("candidates");
    expect(await coordinator.readEncryptedState()).not.toBe(before);
    await expect(decryptStorageState((await coordinator.readEncryptedState())!, encryptionKey)).resolves.toBe(updatedState);
  });

  it("passes a configured ISO alpha-2 browser location to bootstrap and scheduled runs", async () => {
    const setupValue = setup({ browserLocation: "TW" });
    const bootstrap = await setupValue.worker.fetch(request("/admin/bootstrap/start", {
      method: "POST",
      token: adminToken,
    }), setupValue.env);
    expect(bootstrap.status).toBe(200);
    await setupValue.coordinator.storeEncryptedState(await encryptStorageState(initialState, encryptionKey));
    await setupValue.worker.scheduled(
      { scheduledTime: Date.parse('2026-09-28T00:30:00Z'), cron: "30 0 * * *" },
      setupValue.env,
      { waitUntil: vi.fn() },
    );

    expect(setupValue.binding.acquire.mock.calls[0]?.[0]).toMatchObject({ location: "TW" });
    expect(setupValue.binding.acquire.mock.calls[1]?.[0]).toMatchObject({ location: "TW" });
  });

  it("fails closed for an invalid browser location before acquiring a session", async () => {
    const setupValue = setup({ browserLocation: "ZZ" });
    const health = await setupValue.worker.fetch(request("/health"), setupValue.env);
    const bootstrap = await setupValue.worker.fetch(request("/admin/bootstrap/start", {
      method: "POST",
      token: adminToken,
    }), setupValue.env);

    expect(health.status).toBe(500);
    expect(bootstrap.status).toBe(500);
    expect(await bootstrap.json()).toEqual({ error: "INTERNAL_ERROR" });
    expect(setupValue.binding.acquire).not.toHaveBeenCalled();
  });

  it.each(["LOGIN_PROMPT", "CHALLENGE", "CAPTCHA", "UNEXPECTED_CONSENT", "HTTP_429"] as const)(
    "does not update storage state after %s",
    async (reason) => {
      const setupValue = setup();
      setupValue.runScout.mockResolvedValueOnce({ status: "stopped", reason, candidates: [] });
      const encrypted = await encryptStorageState(initialState, encryptionKey);
      await setupValue.coordinator.storeEncryptedState(encrypted);

      const response = await setupValue.worker.fetch(request("/admin/run-once", {
        method: "POST",
        token: adminToken,
      }), setupValue.env);
      expect(await response.json()).toMatchObject({ status: "stopped", stopReason: reason });
      expect(await setupValue.coordinator.readEncryptedState()).toBe(encrypted);
    },
  );

  it("scheduled performs one run without retry or human handoff", async () => {
    const { worker, env, coordinator, binding, runScout } = setup();
    runScout.mockResolvedValueOnce({ status: "stopped", reason: "LOGIN_PROMPT", candidates: [] });
    await coordinator.storeEncryptedState(await encryptStorageState(initialState, encryptionKey));
    const waitUntil = vi.fn();
    await worker.scheduled({ scheduledTime: Date.parse('2026-09-28T00:30:00Z'), cron: "30 0 * * *" }, env, { waitUntil });
    expect(binding.acquire).toHaveBeenCalledOnce();
    expect(runScout).toHaveBeenCalledOnce();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent manual runs with the same trusted request id", async () => {
    const setupValue = setup();
    await setupValue.coordinator.storeEncryptedState(await encryptStorageState(initialState, encryptionKey));
    let release!: (result: ScoutRunResult) => void;
    setupValue.runScout.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const body = JSON.stringify({ requestId: "11111111-1111-4111-8111-111111111111" });
    const invoke = () => setupValue.worker.fetch(request("/admin/run-once", {
      method: "POST",
      token: adminToken,
      body,
    }), setupValue.env);
    const first = invoke();
    const second = invoke();
    await vi.waitFor(() => expect(setupValue.runScout).toHaveBeenCalledOnce());
    release({ status: "completed", candidates: [] });
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(await firstResponse.json()).toEqual(await secondResponse.json());
    expect(setupValue.binding.acquire).toHaveBeenCalledOnce();
    expect(await setupValue.coordinator.getMetrics()).toHaveLength(1);
  });

  it("deduplicates repeated scheduled event ids", async () => {
    const setupValue = setup();
    await setupValue.coordinator.storeEncryptedState(await encryptStorageState(initialState, encryptionKey));
    const event = { scheduledTime: Date.parse('2026-09-28T00:30:00Z'), cron: "30 0 * * *" };
    await Promise.all([
      setupValue.worker.scheduled(event, setupValue.env, { waitUntil: vi.fn() }),
      setupValue.worker.scheduled(event, setupValue.env, { waitUntil: vi.fn() }),
    ]);
    expect(setupValue.runScout).toHaveBeenCalledOnce();
    expect(await setupValue.coordinator.getMetrics()).toHaveLength(1);
  });

  it('uses a consolidated cron without adding any extra browser patrols',async()=>{
    const {worker,env,coordinator,binding}=setup();
    await coordinator.storeEncryptedState(await encryptStorageState(initialState,encryptionKey));
    for(const hour of [0,4,9,14])for(const minute of [0,30]){
      await worker.scheduled({scheduledTime:Date.UTC(2026,8,28,hour,minute),cron:'0,30 0,4,9,14 * * *'},env,{waitUntil:vi.fn()});
    }
    expect(binding.acquire).toHaveBeenCalledTimes(4);
    expect(await coordinator.getMetrics()).toHaveLength(4);
  });

  it("records TIME_LIMIT and closes the session within the cloud run budget", async () => {
    const setupValue = setup();
    await setupValue.coordinator.storeEncryptedState(await encryptStorageState(initialState, encryptionKey));
    setupValue.runScout.mockResolvedValueOnce({
      status: "stopped",
      reason: "TIME_LIMIT",
      candidates: [],
    });

    const response = await setupValue.worker.fetch(request("/admin/run-once", {
      method: "POST",
      token: adminToken,
    }), setupValue.env);
    expect(await response.json()).toMatchObject({ status: "stopped", stopReason: "TIME_LIMIT" });
    expect(CLOUDFLARE_RUN_DURATION_MS).toBeLessThan(15 * 60 * 1000);
    expect(setupValue.raw.browser.close).toHaveBeenCalled();
    expect(setupValue.binding.closeSession).toHaveBeenCalledWith("session-1");
    await expect(setupValue.coordinator.getMetrics()).resolves.toEqual([
      expect.objectContaining({ stopReason: "TIME_LIMIT" }),
    ]);
  });

  it("bounds concurrent run cleanup when browser and session close never settle", async () => {
    const setupValue = setup();
    await setupValue.coordinator.storeEncryptedState(await encryptStorageState(initialState, encryptionKey));
    setupValue.raw.browser.close.mockImplementation(() => new Promise(() => undefined));
    setupValue.binding.closeSession.mockImplementation(() => new Promise(() => undefined));
    const startedAt = performance.now();

    const response = await setupValue.worker.fetch(request("/admin/run-once", {
      method: "POST",
      token: adminToken,
    }), setupValue.env);
    const elapsedMs = performance.now() - startedAt;

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "completed" });
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
    expect(elapsedMs).toBeLessThan(2_500);
    expect(setupValue.raw.browser.close).toHaveBeenCalled();
    expect(setupValue.binding.closeSession).toHaveBeenCalled();
    await expect(setupValue.coordinator.getMetrics()).resolves.toHaveLength(1);
  });

  it("bounds post-run storage capture and records RUN_ERROR without replacing state", async () => {
    const setupValue = setup({ operationBudgetMs: 40 });
    const encrypted = await encryptStorageState(initialState, encryptionKey);
    await setupValue.coordinator.storeEncryptedState(encrypted);
    setupValue.raw.context.storageState.mockImplementation(() => new Promise(() => undefined));
    const startedAt = performance.now();

    const response = await setupValue.worker.fetch(request("/admin/run-once", {
      method: "POST",
      token: adminToken,
    }), setupValue.env);

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(await response.json()).toMatchObject({ status: "stopped", stopReason: "RUN_ERROR" });
    await expect(setupValue.coordinator.readEncryptedState()).resolves.toBe(encrypted);
    expect(setupValue.binding.closeSession).toHaveBeenCalledWith("session-1");
  });

  it("returns by the absolute deadline and closes an acquire session that resolves late", async () => {
    const setupValue = setup({ operationBudgetMs: 100 });
    await setupValue.coordinator.storeEncryptedState(await encryptStorageState(initialState, encryptionKey));
    let resolveAcquire!: (value: { sessionId: string; targets: never[] }) => void;
    setupValue.binding.acquire.mockImplementationOnce(() => new Promise((resolve) => {
      resolveAcquire = resolve;
    }));
    vi.useFakeTimers();
    try {
      const pending = setupValue.worker.fetch(request("/admin/run-once", {
        method: "POST",
        token: adminToken,
      }), setupValue.env);
      await vi.waitFor(() => expect(setupValue.binding.acquire).toHaveBeenCalled());
      const observedAt = Date.now();
      await vi.runAllTimersAsync();
      const response = await pending;

      expect(Date.now() - observedAt).toBeLessThanOrEqual(100);
      expect(await response.json()).toMatchObject({ status: "stopped", stopReason: "RUN_ERROR" });
      expect(setupValue.binding.closeSession).not.toHaveBeenCalled();

      resolveAcquire({ sessionId: "late-session", targets: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(setupValue.binding.closeSession).toHaveBeenCalledWith("late-session");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let hanging cleanup extend beyond the absolute deadline", async () => {
    const setupValue = setup({ operationBudgetMs: 100 });
    await setupValue.coordinator.storeEncryptedState(await encryptStorageState(initialState, encryptionKey));
    setupValue.raw.browser.close.mockImplementation(() => new Promise(() => undefined));
    setupValue.binding.closeSession.mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers();
    try {
      const pending = setupValue.worker.fetch(request("/admin/run-once", {
        method: "POST",
        token: adminToken,
      }), setupValue.env);
      await vi.waitFor(() => expect(setupValue.runScout).toHaveBeenCalled());
      const observedAt = Date.now();
      await vi.runAllTimersAsync();
      const response = await pending;

      expect(Date.now() - observedAt).toBeLessThanOrEqual(100);
      expect(response.status).toBe(200);
      expect(setupValue.raw.browser.close).toHaveBeenCalled();
      expect(setupValue.binding.closeSession).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds bootstrap storage capture and releases the coordinator queue", async () => {
    const setupValue = setup({ bootstrapCommitBudgetMs: 40 });
    const started = await setupValue.worker.fetch(request("/admin/bootstrap/start", {
      method: "POST",
      token: adminToken,
    }), setupValue.env);
    const { bootstrapId } = await started.json() as { bootstrapId: string };
    setupValue.raw.context.storageState.mockImplementation(() => new Promise(() => undefined));
    const startedAt = performance.now();

    const response = await setupValue.worker.fetch(request("/admin/bootstrap/commit", {
      method: "POST",
      token: adminToken,
      body: JSON.stringify({ bootstrapId }),
    }), setupValue.env);

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"INTERNAL_ERROR"}');
    expect(setupValue.raw.browser.close).toHaveBeenCalled();
    expect(setupValue.binding.closeSession).toHaveBeenCalledWith("session-1");
    await expect(setupValue.coordinator.getMetrics()).resolves.toEqual([]);
  });

  it("cleans up an expired bootstrap on the next operation without committing it", async () => {
    const setupValue = setup();
    const bootstrapId = "22222222-2222-4222-8222-222222222222";
    await setupValue.coordinator.storeBootstrap(bootstrapId, {
      sessionId: "expired-session",
      expiresAt: Date.parse("2026-09-28T11:59:59.000Z"),
    });

    const response = await setupValue.worker.fetch(request("/admin/run-once", {
      method: "POST",
      token: adminToken,
    }), setupValue.env);
    expect(response.status).toBe(200);
    expect(setupValue.binding.closeSession).toHaveBeenCalledWith("expired-session");
    await expect(setupValue.coordinator.claimBootstrap(
      bootstrapId,
      Date.parse("2026-09-28T12:00:00.000Z"),
    )).resolves.toBeNull();
  });

  it("returns PENDING before seven runs and APPROVED for a clean 6-of-7 gate", async () => {
    const { worker, env, coordinator } = setup();
    const complete = (index: number): SpikeMetric => ({
      timestamp: new Date(index * 1_000).toISOString(),
      status: "completed",
      candidateCount: index,
      durationMs: 100 + index,
    });
    await coordinator.runOnce("seed:1", async () => complete(1));
    await coordinator.runOnce("seed:2", async () => complete(2));
    let response = await worker.fetch(request("/admin/spike-results", { token: adminToken }), env);
    expect(await response.json()).toMatchObject({
      gate: { decision: "PENDING", completedCount: 2, medianDurationMs: 101.5 },
    });

    const metrics: SpikeMetric[] = [
      ...Array.from({ length: 6 }, (_, index) => complete(index + 1)),
      {
        timestamp: new Date(7_000).toISOString(),
        status: "stopped",
        stopReason: "TIME_LIMIT",
        candidateCount: 0,
        durationMs: 200,
      },
    ];
    for (const [index, metric] of metrics.entries()) {
      await coordinator.runOnce(`gate:${index}`, async () => metric);
    }
    response = await worker.fetch(request("/admin/spike-results", { token: adminToken }), env);
    expect(await response.json()).toMatchObject({
      metrics,
      gate: {
        decision: "APPROVED",
        completedCount: 6,
        manualLoginInterruptions: 0,
        readOnly: true,
        interactionOccurred: false,
        medianDurationMs: 104,
      },
    });
  });

  it("blocks a 6-of-7 gate after a login redirect and counts manual login", async () => {
    const { worker, env, coordinator } = setup();
    const metrics: SpikeMetric[] = [
      ...Array.from({ length: 6 }, (_, index) => ({
        timestamp: new Date(index * 1_000).toISOString(),
        status: "completed" as const,
        candidateCount: index,
        durationMs: 100,
      })),
      {
        timestamp: new Date(7_000).toISOString(),
        status: "stopped",
        stopReason: "LOGIN_PROMPT",
        candidateCount: 0,
        durationMs: 100,
      },
    ];
    for (const [index, metric] of metrics.entries()) {
      await coordinator.runOnce(`login:${index}`, async () => metric);
    }
    const response = await worker.fetch(request("/admin/spike-results", { token: adminToken }), env);
    expect(await response.json()).toMatchObject({
      gate: {
        decision: "BLOCKED",
        completedCount: 6,
        manualLoginInterruptions: 1,
      },
    });
  });

  it("treats an unclassified navigation block as a platform warning", async () => {
    const { worker, env, coordinator } = setup();
    const metrics: SpikeMetric[] = Array.from({ length: 6 }, (_, index) => ({
      timestamp: new Date(index * 1_000).toISOString(),
      status: "completed" as const,
      candidateCount: 0,
      durationMs: 100,
    }));
    metrics.push({
      timestamp: new Date(7_000).toISOString(),
      status: "stopped",
      stopReason: "NAVIGATION_BLOCKED",
      candidateCount: 0,
      durationMs: 100,
    });
    for (const [index, metric] of metrics.entries()) {
      await coordinator.runOnce(`blocked:${index}`, async () => metric);
    }
    const response = await worker.fetch(request("/admin/spike-results", { token: adminToken }), env);
    expect(await response.json()).toMatchObject({
      gate: {
        decision: "BLOCKED",
        warnings: ["NAVIGATION_BLOCKED"],
      },
    });
  });

  it("never returns secrets, cookies, raw HTML, or the optional ingest URL", async () => {
    const { worker, env, coordinator } = setup();
    env.SCOUT_INGEST_URL = "https://ingest.example/private";
    await coordinator.storeEncryptedState(await encryptStorageState(initialState, encryptionKey));
    const responses = await Promise.all([
      worker.fetch(request("/health"), env),
      worker.fetch(request("/admin/run-once", { method: "POST", token: adminToken }), env),
      worker.fetch(request("/admin/spike-results", { token: adminToken }), env),
    ]);
    const text = (await Promise.all(responses.map((response) => response.text()))).join("\n");
    for (const forbidden of [adminToken, encryptionKey, "new-secret", "cookies", "<html", env.SCOUT_INGEST_URL]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
