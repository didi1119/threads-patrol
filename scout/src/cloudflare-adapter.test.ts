import { describe, expect, it, vi } from "vitest";
import {
  ADAPTER_CANCEL_CLEANUP_TIMEOUT_MS,
  THREADS_ALLOWED_DOMAINS,
  createCloudflareReadonlyBrowser,
  hasLoginPromptSignal,
  isAllowedBrowserRequestUrl,
} from "./cloudflare-adapter.js";
import { NavigationBlockedError, type OperationDeadline } from "./runner.js";

function deadline(signal = new AbortController().signal): OperationDeadline {
  return { deadlineMs: Date.now() + 5_000, signal };
}

function makeBrowser(options: {
  response?: { status(): number; url(): string } | null;
  html?: string;
  safety?: Record<string, boolean>;
} = {}) {
  let routeHandler: ((route: {
    request(): {
      url(): string;
      isNavigationRequest(): boolean;
      frame(): { parentFrame(): object | null };
    };
    continue(): Promise<void>;
    abort(): Promise<void>;
  }) => Promise<void>) | undefined;
  const route = vi.fn(async (_pattern: string, handler: typeof routeHandler) => {
    routeHandler = handler;
  });
  const page = {
    route,
    goto: vi.fn(async () => Object.hasOwn(options, "response") ? options.response as null | {
      status(): number;
      url(): string;
    } : {
      status: () => 200,
      url: () => "https://www.threads.com/",
    }),
    url: vi.fn(() => options.response?.url() ?? "https://www.threads.com/"),
    evaluate: vi.fn(async (_fn: unknown, argument: unknown) => {
      if (typeof argument === "number") return {
        currentUrl: page.url(),
        html: (options.html ?? "<html>safe</html>").slice(0, argument + 1),
      };
      return options.safety ?? {};
    }),
    close: vi.fn(async () => undefined),
  };
  const context = { newPage: vi.fn(async () => page) };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
  return { browser, context, page, getRouteHandler: () => routeHandler };
}

describe("Cloudflare readonly browser adapter", () => {
  it("does not treat incidental login wording as an active login prompt", () => {
    expect(hasLoginPromptSignal({
      url: "https://www.threads.com/",
      hasPasswordInput: false,
      hasVisibleLoginControl: false,
    })).toBe(false);
    expect(hasLoginPromptSignal({
      url: "https://www.threads.com/",
      hasPasswordInput: false,
      hasVisibleLoginControl: true,
    })).toBe(true);
    expect(hasLoginPromptSignal({
      url: "https://www.threads.com/login",
      hasPasswordInput: false,
      hasVisibleLoginControl: false,
    })).toBe(true);
  });

  it("exposes only the core read-only surface and returns finite navigation data", async () => {
    const { browser } = makeBrowser();
    const adapter = createCloudflareReadonlyBrowser(browser);
    const page = await adapter.newPage(deadline());

    expect(Object.keys(adapter).sort()).toEqual(["close", "newPage"]);
    expect(Object.keys(page).sort()).toEqual(["close", "content", "getSafetyState", "goto"]);
    await expect(page.goto("https://www.threads.com/", deadline())).resolves.toEqual({
      status: 200,
      finalUrl: "https://www.threads.com/",
    });
  });

  it("fails closed for missing or malformed navigation responses", async () => {
    for (const response of [null, { status: () => Number.NaN, url: () => "https://www.threads.com/" }]) {
      const { browser } = makeBrowser({ response });
      const page = await createCloudflareReadonlyBrowser(browser).newPage(deadline());
      await expect(page.goto("https://www.threads.com/", deadline())).resolves.toEqual({
        status: 0,
        finalUrl: "https://www.threads.com/",
      });
    }
  });

  it("installs a second request allowlist and blocks deceptive wildcard matches", async () => {
    const { browser, page, getRouteHandler } = makeBrowser();
    await createCloudflareReadonlyBrowser(browser).newPage(deadline());
    expect(page.route).toHaveBeenCalledWith("**/*", expect.any(Function));

    expect(THREADS_ALLOWED_DOMAINS).toContain("threads.com");
    expect(THREADS_ALLOWED_DOMAINS).toContain("*.threads.com");
    expect(isAllowedBrowserRequestUrl("https://static.cdninstagram.com/app.js")).toBe(true);
    expect(isAllowedBrowserRequestUrl("https://evilthreads.com/")).toBe(false);
    expect(isAllowedBrowserRequestUrl("data:text/plain,ok")).toBe(true);

    const handler = getRouteHandler();
    expect(handler).toBeDefined();
    const blocked = {
      request: () => ({
        url: () => "https://attacker.example/",
        isNavigationRequest: () => false,
        frame: () => ({ parentFrame: () => ({}) }),
      }),
      continue: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    await handler!(blocked);
    expect(blocked.abort).toHaveBeenCalledOnce();
    expect(blocked.continue).not.toHaveBeenCalled();

    const topLevelCdnNavigation = {
      request: () => ({
        url: () => "https://static.cdninstagram.com/landing",
        isNavigationRequest: () => true,
        frame: () => ({ parentFrame: () => null }),
      }),
      continue: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    await handler!(topLevelCdnNavigation);
    expect(topLevelCdnNavigation.abort).toHaveBeenCalledOnce();

    for (const blockedUrl of [
      "https://www.threads.com/login",
      "https://accounts.instagram.com/login",
      "https://www.meta.com/challenge",
      "https://www.facebook.com/anything?next=/login",
      "http://www.threads.com/login",
      "https://user@www.threads.com/login",
      "https://www.threads.com:444/login",
    ]) {
      const blockedNavigation = {
        request: () => ({
          url: () => blockedUrl,
          isNavigationRequest: () => true,
          frame: () => ({ parentFrame: () => null }),
        }),
        continue: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      };
      await handler!(blockedNavigation);
      expect(blockedNavigation.abort).toHaveBeenCalledOnce();
      expect(blockedNavigation.continue).not.toHaveBeenCalled();
    }
  });

  it("reports an aborted login redirect without reading the blocked page", async () => {
    const { browser, page: rawPage, getRouteHandler } = makeBrowser();
    const page = await createCloudflareReadonlyBrowser(browser).newPage(deadline());
    rawPage.goto.mockImplementationOnce(async () => {
      const route = {
        request: () => ({
          url: () => "https://www.threads.com/login",
          isNavigationRequest: () => true,
          frame: () => ({ parentFrame: () => null }),
        }),
        continue: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
      };
      await getRouteHandler()!(route);
      throw new Error("net::ERR_FAILED");
    });

    await expect(page.goto("https://www.threads.com/", deadline())).resolves.toEqual({
      status: 0,
      finalUrl: "https://www.threads.com/login",
    });
    expect(rawPage.evaluate).not.toHaveBeenCalled();
  });

  it("detects safety stops using DOM and URL read-only evaluation", async () => {
    const safety = { loginPrompt: true, captcha: true };
    const { browser } = makeBrowser({ safety });
    const page = await createCloudflareReadonlyBrowser(browser).newPage(deadline());
    await expect(page.getSafetyState(deadline())).resolves.toEqual(safety);
  });

  it("bounds content and rejects oversized output", async () => {
    const { browser } = makeBrowser({ html: "x".repeat(11) });
    const page = await createCloudflareReadonlyBrowser(browser).newPage(deadline());
    await expect(page.content(deadline(), { maxCharacters: 10 })).rejects.toThrow(
      "Content limit exceeded",
    );
  });

  it('explores fifteen scrolls per pass and refreshes twice, collecting unique snapshots',async()=>{
    const {browser,page:raw}=makeBrowser();let snapshot=0;
    raw.evaluate.mockImplementation(async(_fn,argument):Promise<Record<string,boolean>|{currentUrl:string;html:string}>=>typeof argument==='number'?{currentUrl:raw.url(),html:`<article data-thread-post><a data-post-url href="https://www.threads.com/@a/post/P${snapshot++}"></a></article>`}:{loginPrompt:false});
    const page=await createCloudflareReadonlyBrowser(browser).newPage(deadline());
    const html=await page.content(deadline(),{maxCharacters:200000});
    expect(raw.goto).toHaveBeenCalledTimes(2);
    expect(snapshot).toBe(48);
    expect(html.match(/data-thread-post/g)).toHaveLength(48);
  });

  it("blocks same-document navigation before returning HTML", async () => {
    const { browser, page: rawPage } = makeBrowser({ html: "private page" });
    const page = await createCloudflareReadonlyBrowser(browser).newPage(deadline());
    rawPage.url.mockReturnValue("https://www.threads.com/settings");
    await expect(page.content(deadline(), { maxCharacters: 100 })).rejects.toBeInstanceOf(
      NavigationBlockedError,
    );
  });

  it("propagates cancellation to the underlying page close", async () => {
    const controller = new AbortController();
    const { browser, page: rawPage } = makeBrowser();
    rawPage.goto.mockImplementationOnce(() => new Promise(() => undefined));
    const page = await createCloudflareReadonlyBrowser(browser).newPage(deadline(controller.signal));
    const navigation = page.goto("https://www.threads.com/", deadline(controller.signal));
    controller.abort();

    await expect(navigation).rejects.toThrow("aborted");
    expect(rawPage.close).toHaveBeenCalledOnce();
  });

  it("does not reject cancellation until close settles", async () => {
    const controller = new AbortController();
    let finishClose: (() => void) | undefined;
    const { browser, page: rawPage } = makeBrowser();
    rawPage.goto.mockImplementationOnce(() => new Promise(() => undefined));
    rawPage.close.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      finishClose = () => resolve(undefined);
    }));
    const page = await createCloudflareReadonlyBrowser(browser).newPage(deadline(controller.signal));
    const navigation = page.goto("https://www.threads.com/", deadline(controller.signal));
    let settled = false;
    const expectation = expect(navigation.finally(() => {
      settled = true;
    })).rejects.toThrow("aborted");

    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishClose?.();
    await expectation;
    expect(settled).toBe(true);
  });

  it("bounds a never-settling close after cancellation", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { browser, page: rawPage } = makeBrowser();
      rawPage.goto.mockImplementationOnce(() => new Promise(() => undefined));
      rawPage.close.mockImplementationOnce(() => new Promise(() => undefined));
      const page = await createCloudflareReadonlyBrowser(browser).newPage(deadline(controller.signal));
      const navigation = page.goto("https://www.threads.com/", deadline(controller.signal));
      let settled = false;
      const expectation = expect(navigation.finally(() => {
        settled = true;
      })).rejects.toThrow("aborted");

      controller.abort();
      await vi.advanceTimersByTimeAsync(ADAPTER_CANCEL_CLEANUP_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expectation;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces deadlineMs when an evaluation never settles", async () => {
    vi.useFakeTimers();
    try {
      const { browser, page: rawPage } = makeBrowser();
      rawPage.evaluate.mockImplementationOnce(() => new Promise(() => undefined));
      const page = await createCloudflareReadonlyBrowser(browser).newPage(deadline());
      const safety = page.getSafetyState({
        deadlineMs: Date.now() + 25,
        signal: new AbortController().signal,
      });
      const expectation = expect(safety).rejects.toThrow("deadline");
      await vi.advanceTimersByTimeAsync(25);
      await expectation;
      expect(rawPage.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
