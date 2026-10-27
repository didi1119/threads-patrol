import { describe, expect, it, vi } from "vitest";
import {
  CLEANUP_TIMEOUT_MS,
  MAX_FEED_HTML_CHARACTERS,
  NavigationBlockedError,
  isAllowedNavigationUrl,
  runScout,
  safetyStopReasonFromUrl,
  type OperationDeadline,
  validateScheduleWindows,
} from "./runner.js";
import { sanitizeUploadPayload } from "./upload.js";

const safeHtml = `
  <article data-thread-post data-author-handle="author">
    <a data-post-url href="https://www.threads.com/@author/post/D-example">post</a>
    <p data-post-text>Visible text</p>
    <time data-posted-at datetime="2026-09-28T11:30:00.000Z"></time>
    <span data-likes="3"></span><span data-replies="2"></span>
  </article>`;

function makeBrowser(options: {
  status?: number;
  finalUrl?: string;
  safety?: Partial<Record<"loginPrompt" | "checkpoint" | "captcha" | "challenge" | "unexpectedConsent", boolean>>;
  safetyStates?: Array<Partial<Record<"loginPrompt" | "checkpoint" | "captcha" | "challenge" | "unexpectedConsent", boolean>>>;
  html?: string;
} = {}) {
  const safetyStates = [...(options.safetyStates ?? [])];
  const page = {
    goto: vi.fn(async (_url: string, _deadline: OperationDeadline) => ({
      status: Object.hasOwn(options, "status") ? options.status as number : 200,
      finalUrl: options.finalUrl ?? "https://www.threads.com/",
    })),
    getSafetyState: vi.fn(async (_deadline: OperationDeadline) => safetyStates.shift() ?? options.safety ?? {}),
    content: vi.fn(async (_deadline: OperationDeadline, _limits: { maxCharacters: number }) => options.html ?? safeHtml),
    close: vi.fn(async (): Promise<void> => undefined),
  };
  const browser = {
    newPage: vi.fn(async (_deadline: OperationDeadline) => page),
    close: vi.fn(async (): Promise<void> => undefined),
  };
  return { browser, page };
}

describe("navigation allowlist", () => {
  it.each([
    "https://www.threads.com/",
    "https://threads.com/search?q=forest",
    "https://www.threads.com/@author/post/D-example",
  ])("allows %s", (url) => expect(isAllowedNavigationUrl(url)).toBe(true));

  it.each([
    "javascript:alert(1)",
    "http://www.threads.com/",
    "https://evil.example/",
    "https://www.threads.com/settings",
    "https://www.threads.com/@author/replies",
    "https://www.threads.com:443/",
    "https://user@www.threads.com/",
    "https://threadѕ.com/",
    "https://www.threads.com/%73earch",
    "https://www.threads.com/@author/%70ost/D-example",
    "https://www.threads.com/#fragment",
  ])("refuses %s", (url) => expect(isAllowedNavigationUrl(url)).toBe(false));

  it("normalizes protocol and host casing without widening path rules", () => {
    expect(isAllowedNavigationUrl("HTTPS://THREADS.COM/search?q=forest")).toBe(true);
    expect(isAllowedNavigationUrl("HTTPS://THREADS.COM/@Author/post/D-example")).toBe(true);
  });
});

describe("safety redirect URL classification", () => {
  it.each([
    ["https://www.threads.com/login", "LOGIN_PROMPT"],
    ["https://accounts.instagram.com/login/", "LOGIN_PROMPT"],
    ["https://www.facebook.com/checkpoint/123", "CHECKPOINT"],
    ["https://www.meta.com/challenge/123", "CHALLENGE"],
  ] as const)("classifies trusted HTTPS safety route %s", (url, reason) => {
    expect(safetyStopReasonFromUrl(url)).toBe(reason);
  });

  it.each([
    "https://www.facebook.com/anything?next=/login",
    "https://evil.facebook.com/login",
    "https://instagram.com.evil.example/login",
    "https://meta.com.evil.example/challenge",
    "http://www.threads.com/login",
    "https://user@www.threads.com/login",
    "https://www.threads.com:444/login",
    "https://www.threads.com/anything?next=/checkpoint",
  ])("does not trust malformed or query-only safety URL %s", (url) => {
    expect(safetyStopReasonFromUrl(url)).toBeNull();
  });
});

describe("runScout", () => {
  it.each([
    ["loginPrompt", "LOGIN_PROMPT"],
    ["checkpoint", "CHECKPOINT"],
    ["captcha", "CAPTCHA"],
    ["challenge", "CHALLENGE"],
    ["unexpectedConsent", "UNEXPECTED_CONSENT"],
  ] as const)("stops immediately for %s without reading feed content", async (signal, reason) => {
    const { browser, page } = makeBrowser({ safety: { [signal]: true } });

    await expect(
      runScout(browser, {
        targetUrl: "https://www.threads.com/",
        ownHandle: "quietforest",
        seenUrls: [],
        timeWindowMs: 60 * 60 * 1000,
        now: new Date("2026-09-28T12:00:00.000Z"),
      }),
    ).resolves.toEqual({ status: "stopped", reason, candidates: [] });
    expect(page.content).not.toHaveBeenCalled();
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  it("stops immediately on HTTP 429 without checking or retrying", async () => {
    const { browser, page } = makeBrowser({ status: 429 });

    const result = await runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    });

    expect(result).toEqual({ status: "stopped", reason: "HTTP_429", candidates: [] });
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.getSafetyState).not.toHaveBeenCalled();
    expect(page.content).not.toHaveBeenCalled();
  });

  it.each([
    ["https://www.threads.com/login", "LOGIN_PROMPT"],
    ["https://accounts.instagram.com/login", "LOGIN_PROMPT"],
    ["https://www.threads.com/checkpoint/123", "CHECKPOINT"],
    ["https://www.threads.com/challenge/123", "CHALLENGE"],
    ["https://www.facebook.com/captcha", "CAPTCHA"],
    ["https://www.threads.com/privacy/consent", "UNEXPECTED_CONSENT"],
  ] as const)("preserves safety reason %s after a redirect", async (finalUrl, reason) => {
    const { browser, page } = makeBrowser({ finalUrl });

    await expect(runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    })).resolves.toEqual({ status: "stopped", reason, candidates: [] });
    expect(page.getSafetyState).not.toHaveBeenCalled();
    expect(page.content).not.toHaveBeenCalled();
  });

  it("uses NAVIGATION_BLOCKED for an unknown redirect", async () => {
    const { browser } = makeBrowser({ finalUrl: "https://evil.example/capture" });
    await expect(runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    })).resolves.toEqual({ status: "stopped", reason: "NAVIGATION_BLOCKED", candidates: [] });
  });

  it.each([401, 403, 407, 408, 409, 500, 503])(
    "fails closed for HTTP %s",
    async (status) => {
      const { browser, page } = makeBrowser({ status });

      await expect(runScout(browser, {
        targetUrl: "https://www.threads.com/",
        ownHandle: "quietforest",
        seenUrls: [],
        timeWindowMs: 60_000,
        now: new Date("2026-09-28T12:00:00.000Z"),
      })).resolves.toEqual({ status: "stopped", reason: "HTTP_ERROR", candidates: [] });
      expect(page.getSafetyState).not.toHaveBeenCalled();
      expect(page.content).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 200.5, "200"])(
    "fails closed for malformed HTTP status %s",
    async (status) => {
      const { browser, page } = makeBrowser({ status: status as never });

      await expect(runScout(browser, {
        targetUrl: "https://www.threads.com/",
        ownHandle: "quietforest",
        seenUrls: [],
        timeWindowMs: 60_000,
        now: new Date("2026-09-28T12:00:00.000Z"),
      })).resolves.toEqual({ status: "stopped", reason: "HTTP_ERROR", candidates: [] });
      expect(page.content).not.toHaveBeenCalled();
    },
  );

  it("rechecks safety after content and stops on a dynamic challenge", async () => {
    const { browser, page } = makeBrowser({
      safetyStates: [{}, { challenge: true }],
    });

    await expect(runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    })).resolves.toEqual({ status: "stopped", reason: "CHALLENGE", candidates: [] });
    expect(page.getSafetyState).toHaveBeenCalledTimes(2);
  });

  it("maps an adapter-detected same-document redirect to NAVIGATION_BLOCKED", async () => {
    const { browser, page } = makeBrowser();
    page.content.mockRejectedValueOnce(new NavigationBlockedError());

    await expect(runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    })).resolves.toEqual({ status: "stopped", reason: "NAVIGATION_BLOCKED", candidates: [] });
  });

  it("refuses disallowed navigation before creating a page", async () => {
    const { browser } = makeBrowser();
    await expect(
      runScout(browser, {
        targetUrl: "https://evil.example/",
        ownHandle: "quietforest",
        seenUrls: [],
        timeWindowMs: 60_000,
        now: new Date("2026-09-28T12:00:00.000Z"),
      }),
    ).rejects.toThrow("Navigation URL is not allowed");
    expect(browser.newPage).not.toHaveBeenCalled();
  });

  it("returns at most 40 unique posts", async () => {
    const posts = Array.from({ length: 45 }, (_, index) => `
      <article data-thread-post data-author-handle="author${index}">
        <a data-post-url href="https://www.threads.com/@author${index}/post/D-${index}">post</a>
        <p data-post-text>Post ${index}</p>
        <time data-posted-at datetime="2026-09-28T11:30:00.000Z"></time>
      </article>`).join("");
    const { browser } = makeBrowser({ html: posts + posts });

    const result = await runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60 * 60 * 1000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    });

    expect(result.status).toBe("completed");
    expect(result.candidates).toHaveLength(40);
    expect(new Set(result.candidates.map((candidate) => candidate.sourceUrl))).toHaveLength(40);
  });

  it("passes one hard 25 minute deadline to every page operation", async () => {
    const { browser, page } = makeBrowser();

    await runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    }, { clock: () => 1_000 });

    const deadline = expect.objectContaining({
      deadlineMs: 1_000 + 25 * 60 * 1000,
      signal: expect.any(AbortSignal),
    });
    expect(page.goto).toHaveBeenCalledWith("https://www.threads.com/", deadline);
    expect(page.getSafetyState).toHaveBeenCalledWith(deadline);
    expect(page.content).toHaveBeenCalledWith(deadline, {
      maxCharacters: MAX_FEED_HTML_CHARACTERS,
      stats:{},
    });
  });

  it("accepts a smaller per-run duration without widening the 25 minute maximum", async () => {
    const { browser, page } = makeBrowser();
    const setTimer = vi.fn(() => 1);

    await runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
      maxDurationMs: 9 * 60 * 1000,
    }, { clock: () => 1_000, setTimer, clearTimer: vi.fn() });

    expect(page.goto).toHaveBeenCalledWith("https://www.threads.com/", expect.objectContaining({
      deadlineMs: 1_000 + 9 * 60 * 1000,
    }));
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 9 * 60 * 1000);
  });

  it.each([0, -1, 25 * 60 * 1000 + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid per-run duration %s before opening a page",
    async (maxDurationMs) => {
      const { browser } = makeBrowser();
      await expect(runScout(browser, {
        targetUrl: "https://www.threads.com/",
        ownHandle: "quietforest",
        seenUrls: [],
        timeWindowMs: 60_000,
        now: new Date("2026-09-28T12:00:00.000Z"),
        maxDurationMs,
      })).rejects.toThrow("run duration");
      expect(browser.newPage).not.toHaveBeenCalled();
    },
  );

  it("stops when the 25 minute runtime budget is exhausted", async () => {
    const { browser } = makeBrowser();
    const clock = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(25 * 60 * 1000 + 1);

    const result = await runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    }, { clock });

    expect(result).toEqual({ status: "stopped", reason: "TIME_LIMIT", candidates: [] });
  });

  it("enforces the deadline even when page creation never settles", async () => {
    const browser = {
      newPage: vi.fn(() => new Promise<never>(() => undefined)),
      close: vi.fn(async () => undefined),
    };

    const result = await runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    }, {
      clock: () => 1_000,
      setTimer: (callback) => {
        queueMicrotask(callback);
        return 1;
      },
      clearTimer: vi.fn(),
    });

    expect(result).toEqual({ status: "stopped", reason: "TIME_LIMIT", candidates: [] });
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("aborts page creation and closes a page that resolves after timeout", async () => {
    let resolvePage: ((page: ReturnType<typeof makeBrowser>["page"]) => void) | undefined;
    let fireTimeout: (() => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const { page } = makeBrowser();
    const browser = {
      newPage: vi.fn((deadline: { signal: AbortSignal }) => {
        observedSignal = deadline.signal;
        return new Promise<typeof page>((resolve) => {
          resolvePage = resolve;
        });
      }),
      close: vi.fn(async () => undefined),
    };

    const run = runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    }, {
      clock: () => 1_000,
      setTimer: (callback) => {
        fireTimeout = callback;
        return 1;
      },
      clearTimer: vi.fn(),
    });

    expect(observedSignal?.aborted).toBe(false);
    fireTimeout?.();
    await expect(run).resolves.toEqual({ status: "stopped", reason: "TIME_LIMIT", candidates: [] });
    expect(observedSignal?.aborted).toBe(true);

    resolvePage?.(page);
    await Promise.resolve();
    await Promise.resolve();
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("preserves a structured stop when cleanup fails and attempts both closes", async () => {
    const { browser, page } = makeBrowser({ status: 429 });
    page.close.mockRejectedValueOnce(new Error("page close failed"));
    browser.close.mockRejectedValueOnce(new Error("browser close failed"));

    await expect(runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    })).resolves.toEqual({ status: "stopped", reason: "HTTP_429", candidates: [] });
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("preserves a structured stop when cleanup throws synchronously", async () => {
    const { browser, page } = makeBrowser({ status: 429 });
    page.close.mockImplementationOnce(() => {
      throw new Error("sync page close");
    });
    browser.close.mockImplementationOnce(() => {
      throw new Error("sync browser close");
    });

    await expect(runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    })).resolves.toEqual({ status: "stopped", reason: "HTTP_429", candidates: [] });
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("aborts immediately and bounds never-settling cleanup independently", async () => {
    let operationSignal: AbortSignal | undefined;
    const never = new Promise<void>(() => undefined);
    const { browser, page } = makeBrowser({ status: 429 });
    page.goto.mockImplementationOnce(async (_url, deadline) => {
      operationSignal = deadline.signal;
      return { status: 429, finalUrl: "https://www.threads.com/" };
    });
    page.close.mockImplementationOnce(() => {
      expect(operationSignal?.aborted).toBe(true);
      return never;
    });
    browser.close.mockImplementationOnce(() => {
      expect(operationSignal?.aborted).toBe(true);
      return never;
    });
    const clearTimer = vi.fn(() => {
      throw new Error("clear timer failed");
    });

    await expect(runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    }, {
      setTimer: (callback, delayMs) => {
        if (delayMs === CLEANUP_TIMEOUT_MS) queueMicrotask(callback);
        return delayMs;
      },
      clearTimer,
    })).resolves.toEqual({ status: "stopped", reason: "HTTP_429", candidates: [] });
    expect(operationSignal?.aborted).toBe(true);
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(clearTimer).toHaveBeenCalled();
  });

  it("stops before parsing an oversized feed document", async () => {
    const { browser } = makeBrowser({ html: "x".repeat(MAX_FEED_HTML_CHARACTERS + 1) });

    await expect(runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    })).resolves.toEqual({ status: "stopped", reason: "CONTENT_LIMIT", candidates: [] });
  });

  it("returns a structured stop for extractor structural limits", async () => {
    const { browser } = makeBrowser({
      html: "<article data-thread-post></article>".repeat(251),
    });

    await expect(runScout(browser, {
      targetUrl: "https://www.threads.com/",
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    })).resolves.toEqual({ status: "stopped", reason: "CONTENT_LIMIT", candidates: [] });
  });
});

describe("schedule policy", () => {
  it("accepts at most four windows per Asia/Taipei operating day", () => {
    const four = [0, 1, 2, 3].map((hour) => new Date(`2026-09-28T0${hour}:00:00.000Z`));
    expect(validateScheduleWindows(four)).toEqual({ valid: true });
    expect(validateScheduleWindows([...four, new Date("2026-09-28T04:00:00.000Z")])).toEqual({
      valid: false,
      reason: "TOO_MANY_WINDOWS_PER_DAY",
      day: "2026-09-28",
    });
  });

  it("groups UTC timestamps by the Asia/Taipei calendar day", () => {
    const sameTaipeiDayAcrossUtcDates = [
      "2026-09-28T16:00:00.000Z",
      "2026-09-28T17:00:00.000Z",
      "2026-09-28T18:00:00.000Z",
      "2026-09-28T19:00:00.000Z",
      "2026-09-29T01:00:00.000Z",
    ].map((timestamp) => new Date(timestamp));

    expect(validateScheduleWindows(sameTaipeiDayAcrossUtcDates)).toEqual({
      valid: false,
      reason: "TOO_MANY_WINDOWS_PER_DAY",
      day: "2026-09-29",
    });
  });

  it("rejects duplicate timestamps", () => {
    const timestamp = new Date("2026-09-28T16:00:00.000Z");
    expect(validateScheduleWindows([timestamp, new Date(timestamp.getTime())])).toEqual({
      valid: false,
      reason: "DUPLICATE_WINDOW",
      timestamp: "2026-09-28T16:00:00.000Z",
    });
  });
});

describe("upload sanitizer", () => {
  it("keeps only public allowlisted fields", () => {
    const unsafeCandidate = {
      sourcePostId: "D-example",
      sourceUrl: "https://threads.com/@author/post/D-example",
      authorHandle: "author",
      text: "Visible text",
      discoveredAt: "2026-09-28T12:00:00.000Z",
      visibleMetrics: { likes: 3, replies: 2 },
      cookie: "secret",
      password: "secret",
      storageState: { token: "secret" },
      html: "<html>secret</html>",
      screenshot: "secret.png",
    };

    expect(sanitizeUploadPayload([unsafeCandidate])).toEqual([
      {
        postUrl: "https://www.threads.com/@author/post/D-example",
        visibleText: "Visible text",
        discoveredAt: "2026-09-28T12:00:00.000Z",
        publicMetrics: { likes: 3, replies: 2 },
      },
    ]);
  });

  it.each([
    ["object text", { text: new String("not primitive") }],
    ["overlong text", { text: "x".repeat(5_001) }],
    ["invalid timestamp", { discoveredAt: "not-a-date" }],
    ["non-canonical timestamp", { discoveredAt: "2026-09-28T12:00:00Z" }],
    ["unsafe URL", { sourceUrl: "https://evil.example/post/1" }],
  ])("rejects %s at runtime", (_label, override) => {
    const candidate = {
      sourcePostId: "D-example",
      sourceUrl: "https://www.threads.com/@author/post/D-example",
      authorHandle: "author",
      text: "Visible text",
      discoveredAt: "2026-09-28T12:00:00.000Z",
      visibleMetrics: { likes: 3, replies: 2 },
      ...override,
    };
    expect(() => sanitizeUploadPayload([candidate as never])).toThrow();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1_000_000_001])(
    "rejects invalid public metric %s",
    (likes) => {
      const candidate = {
        sourcePostId: "D-example",
        sourceUrl: "https://www.threads.com/@author/post/D-example",
        authorHandle: "author",
        text: "Visible text",
        discoveredAt: "2026-09-28T12:00:00.000Z",
        visibleMetrics: { likes, replies: 2 },
      };
      expect(() => sanitizeUploadPayload([candidate as never])).toThrow();
    },
  );

  it("rejects nested toJSON objects and accessors without executing them", () => {
    const toJSON = vi.fn(() => 3);
    const textGetter = vi.fn(() => "Visible text");
    const candidate = {
      sourcePostId: "D-example",
      sourceUrl: "https://www.threads.com/@author/post/D-example",
      authorHandle: "author",
      discoveredAt: "2026-09-28T12:00:00.000Z",
      visibleMetrics: { likes: { toJSON }, replies: 2 },
    };
    Object.defineProperty(candidate, "text", { enumerable: true, get: textGetter });

    expect(() => sanitizeUploadPayload([candidate as never])).toThrow("plain data");
    expect(textGetter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("rejects an overlong otherwise-valid post URL", () => {
    const candidate = {
      sourceUrl: `https://www.threads.com/@author/post/${"D".repeat(2_100)}`,
      text: "Visible text",
      discoveredAt: "2026-09-28T12:00:00.000Z",
      visibleMetrics: { likes: 3, replies: 2 },
    };
    expect(() => sanitizeUploadPayload([candidate])).toThrow("bounded primitive string");
  });

  it("rejects more than 40 upload candidates before mapping", () => {
    const candidate = {
      sourceUrl: "https://www.threads.com/@author/post/D-example",
      text: "Visible text",
      discoveredAt: "2026-09-28T12:00:00.000Z",
      visibleMetrics: { likes: 3, replies: 2 },
    };
    expect(() => sanitizeUploadPayload(Array.from({ length: 41 }, () => candidate))).toThrow(
      "candidate limit",
    );
  });

  it("rejects an overridden array map instead of executing it", () => {
    const candidate = {
      sourceUrl: "https://www.threads.com/@author/post/D-example",
      text: "Visible text",
      discoveredAt: "2026-09-28T12:00:00.000Z",
      visibleMetrics: { likes: 3, replies: 2 },
    };
    const candidates = [candidate];
    const maliciousMap = vi.fn(() => [{ postUrl: "https://evil.example", visibleText: "secret" }]);
    Object.defineProperty(candidates, "map", { value: maliciousMap, enumerable: true });

    expect(() => sanitizeUploadPayload(candidates)).toThrow("plain data array");
    expect(maliciousMap).not.toHaveBeenCalled();
  });

  it("rejects sparse candidate arrays", () => {
    const candidates = new Array(1) as unknown[];
    expect(() => sanitizeUploadPayload(candidates)).toThrow("plain data array");
  });
});
