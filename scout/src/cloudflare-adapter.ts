import type {
  OperationDeadline,
  ReadonlyBrowserAdapter,
  ReadonlyPageAdapter,
  SafetyState,
} from "./runner.js";
import { readLiveFeed } from "./live-feed.js";
import {FeedDiscovery,MAX_REFRESHES,MAX_DISCOVERED_POSTS,SCROLLS_PER_PASS} from './feed-discovery.js';
import type {DiscoveryStats} from './feed-discovery.js';
import {
  NavigationBlockedError,
  isAllowedNavigationUrl,
} from "./runner.js";

export const THREADS_ALLOWED_DOMAINS = [
  "threads.com",
  "*.threads.com",
  "instagram.com",
  "*.instagram.com",
  "cdninstagram.com",
  "*.cdninstagram.com",
  "fbcdn.net",
  "*.fbcdn.net",
  "facebook.com",
  "*.facebook.com",
] as const;
export const ADAPTER_CANCEL_CLEANUP_TIMEOUT_MS = 250;

export function hasLoginPromptSignal(value: {
  url: string;
  hasPasswordInput: boolean;
  hasVisibleLoginControl: boolean;
}): boolean {
  return /\/login(?:\/|\?|$)/.test(value.url.toLowerCase()) ||
    value.hasPasswordInput ||
    value.hasVisibleLoginControl;
}

interface CloudflareResponseLike {
  status(): number;
  url(): string;
}

interface CloudflareRouteLike {
  request(): {
    url(): string;
    isNavigationRequest(): boolean;
    frame(): { parentFrame(): object | null };
  };
  continue(): Promise<void>;
  abort(): Promise<void>;
}

export interface CloudflarePageLike {
  route(pattern: string, handler: (route: CloudflareRouteLike) => Promise<void>): Promise<void>;
  goto(url: string, options: { timeout: number; waitUntil: "domcontentloaded" }): Promise<CloudflareResponseLike | null>;
  url(): string;
  evaluate(pageFunction: (argument: unknown) => unknown, argument: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface CloudflareContextLike {
  newPage(): Promise<CloudflarePageLike>;
}

export interface CloudflareBrowserLike {
  newContext(): Promise<CloudflareContextLike>;
  close(): Promise<void>;
}

function hostnameMatchesPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const apex = pattern.slice(2);
    return hostname.endsWith(`.${apex}`) && hostname.length > apex.length + 1;
  }
  return hostname === pattern;
}

export function isAllowedBrowserRequestUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (["data:", "blob:", "about:"].includes(url.protocol)) return true;
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
    return THREADS_ALLOWED_DOMAINS.some((pattern) => hostnameMatchesPattern(url.hostname, pattern));
  } catch {
    return false;
  }
}

function remainingMs(deadline: OperationDeadline): number {
  return Math.max(1, deadline.deadlineMs - Date.now());
}

async function withCancellation<T>(
  operation: Promise<T>,
  deadline: OperationDeadline,
  cancel: () => Promise<void>,
): Promise<T> {
  const operationResult = operation.then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  const closeWithinLimit = async (): Promise<void> => {
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupLimit = new Promise<void>((resolve) => {
      cleanupTimer = setTimeout(resolve, ADAPTER_CANCEL_CLEANUP_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        Promise.resolve().then(cancel).catch(() => undefined),
        cleanupLimit,
      ]);
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer);
    }
  };
  if (deadline.signal.aborted || deadline.deadlineMs <= Date.now()) {
    await closeWithinLimit();
    throw new Error("Browser operation aborted");
  }
  let listener: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    listener = () => {
      resolve("aborted");
    };
    deadline.signal.addEventListener("abort", listener, { once: true });
  });
  const expired = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => {
      resolve("deadline");
    }, remainingMs(deadline));
  });
  try {
    const result = await Promise.race([
      operationResult,
      aborted.then((reason) => ({ kind: "cancel" as const, reason })),
      expired.then((reason) => ({ kind: "cancel" as const, reason })),
    ]);
    if (result.kind === "value") return result.value;
    if (result.kind === "error") throw result.error;
    await closeWithinLimit();
    throw new Error(result.reason === "deadline"
      ? "Browser operation deadline exceeded"
      : "Browser operation aborted");
  } finally {
    if (listener) deadline.signal.removeEventListener("abort", listener);
    if (timer) clearTimeout(timer);
  }
}

class CloudflareReadonlyPage implements ReadonlyPageAdapter {
  private blockedNavigationUrl: string | undefined;

  constructor(private readonly page: CloudflarePageLike) {}

  async installRequestGuard(): Promise<void> {
    await this.page.route("**/*", async (route) => {
      const request = route.request();
      const isTopLevelNavigation = request.isNavigationRequest() && request.frame().parentFrame() === null;
      const allowed = isTopLevelNavigation
        ? isAllowedNavigationUrl(request.url())
        : isAllowedBrowserRequestUrl(request.url());
      if (allowed) {
        await route.continue();
      } else {
        if (isTopLevelNavigation) this.blockedNavigationUrl = request.url();
        await route.abort();
      }
    });
  }

  async goto(url: string, deadline: OperationDeadline): Promise<{ status: number; finalUrl: string }> {
    this.blockedNavigationUrl = undefined;
    let response: CloudflareResponseLike | null;
    try {
      response = await withCancellation(
        this.page.goto(url, {
          timeout: remainingMs(deadline),
          waitUntil: "domcontentloaded",
        }),
        deadline,
        () => this.page.close(),
      );
    } catch (error) {
      if (this.blockedNavigationUrl) {
        return { status: 0, finalUrl: this.blockedNavigationUrl };
      }
      throw error;
    }
    const status = response?.status();
    return {
      status: typeof status === "number" && Number.isFinite(status) ? status : 0,
      finalUrl: response?.url() ?? this.page.url(),
    };
  }

  async getSafetyState(deadline: OperationDeadline): Promise<SafetyState> {
    const result = await withCancellation(
      this.page.evaluate(() => {
        const url = location.href.toLowerCase();
        const text = (document.body?.innerText ?? "").slice(0, 40_000).toLowerCase();
        const has = (pattern: RegExp) => pattern.test(text);
        const selector = (value: string) => document.querySelector(value) !== null;
        const hasVisibleLoginControl = Array.from(
          document.querySelectorAll('button, a, [role="button"]'),
        ).some((element) => {
          const label = (element.textContent ?? "").trim().toLowerCase();
          if (!/^(?:log in|sign in|登入|登錄)$/.test(label)) return false;
          const htmlElement = element as HTMLElement;
          const style = getComputedStyle(htmlElement);
          return style.display !== "none" && style.visibility !== "hidden" &&
            htmlElement.getClientRects().length > 0;
        });
        const hasVisibleConsentDialog = Array.from(
          document.querySelectorAll('[role="dialog"]'),
        ).some((element) => {
          const htmlElement = element as HTMLElement;
          const style = getComputedStyle(htmlElement);
          if (
            style.display === "none" || style.visibility === "hidden" ||
            htmlElement.getClientRects().length === 0
          ) return false;
          const dialogText = (htmlElement.textContent ?? "").slice(0, 10_000).toLowerCase();
          return /accept.*cookies|allow all cookies|同意.*cookie|接受.*cookie/.test(dialogText) &&
            htmlElement.querySelector('button, [role="button"]') !== null;
        });
        return {
          url,
          hasPasswordInput: selector('input[type="password"]'),
          hasVisibleLoginControl,
          checkpoint: /checkpoint/.test(url) || has(/security check|安全檢查|確認是你本人/),
          captcha:
            selector('iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i]') ||
            has(/captcha|i['’]?m not a robot|我不是機器人/),
          challenge: /challenge/.test(url) || has(/suspicious activity|unusual activity|可疑活動|異常活動/),
          unexpectedConsent: hasVisibleConsentDialog,
        };
      }, null),
      deadline,
      () => this.page.close(),
    );
    if (typeof result !== "object" || result === null || Array.isArray(result)) return {};
    const safety: SafetyState = {};
    const url = Reflect.get(result, "url");
    const hasPasswordInput = Reflect.get(result, "hasPasswordInput");
    const hasVisibleLoginControl = Reflect.get(result, "hasVisibleLoginControl");
    if (
      typeof url === "string" &&
      typeof hasPasswordInput === "boolean" &&
      typeof hasVisibleLoginControl === "boolean" &&
      hasLoginPromptSignal({ url, hasPasswordInput, hasVisibleLoginControl })
    ) {
      safety.loginPrompt = true;
    }
    for (const key of ["loginPrompt", "checkpoint", "captcha", "challenge", "unexpectedConsent"] as const) {
      if (Reflect.get(result, key) === true) safety[key] = true;
    }
    return safety;
  }

  async content(
    deadline: OperationDeadline,
    limits: { maxCharacters: number; stats?: DiscoveryStats },
  ): Promise<string> {
    if (!Number.isSafeInteger(limits.maxCharacters) || limits.maxCharacters < 1) {
      throw new Error("Invalid content limit");
    }
    await withCancellation(this.page.evaluate(async () => {
      for (let i = 0; i < 8 && !document.querySelector('a[href*="/post/"]'); i++) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      return true;
    }, null), deadline, () => this.page.close());
    const result = await withCancellation(
      this.page.evaluate(
        readLiveFeed,
        limits.maxCharacters,
      ),
      deadline,
      () => this.page.close(),
    );
    if (
      typeof result !== "object" ||
      result === null ||
      typeof Reflect.get(result, "currentUrl") !== "string" ||
      typeof Reflect.get(result, "html") !== "string"
    ) {
      throw new Error("Invalid page content");
    }
    if (!isAllowedNavigationUrl(String(Reflect.get(result, "currentUrl")))) {
      throw new NavigationBlockedError();
    }
    const discovery=new FeedDiscovery(limits.maxCharacters);
    discovery.add(String(Reflect.get(result,'html')));
    let refreshCount=0,scrollCount=0;
    for(let pass=0;pass<=MAX_REFRESHES;pass++){
      if(pass){
        if(Object.values(await this.getSafetyState(deadline)).some(Boolean))break;
        const navigation=await this.goto('https://www.threads.com/',deadline);
        if(navigation.status!==200||!isAllowedNavigationUrl(navigation.finalUrl))throw new NavigationBlockedError();
        refreshCount++;
        if(Object.values(await this.getSafetyState(deadline)).some(Boolean))break;
        await withCancellation(this.page.evaluate(async()=>{for(let i=0;i<8&&!document.querySelector('a[href*="/post/"]');i++)await new Promise(resolve=>setTimeout(resolve,1000));return true;},null),deadline,()=>this.page.close());
        const fresh=await withCancellation(this.page.evaluate(readLiveFeed,limits.maxCharacters),deadline,()=>this.page.close());
        if(!fresh||typeof fresh!=='object'||typeof Reflect.get(fresh,'html')!=='string')throw new Error('Invalid page content');
        if(!isAllowedNavigationUrl(String(Reflect.get(fresh,'currentUrl'))))throw new NavigationBlockedError();
        discovery.beginPass();discovery.add(String(Reflect.get(fresh,'html')));
      }
      for (let round = 0; round < SCROLLS_PER_PASS && discovery.count<MAX_DISCOVERED_POSTS; round++) {
      if (Object.values(await this.getSafetyState(deadline)).some(Boolean)) break;
      await withCancellation(this.page.evaluate(async () => {
        window.scrollBy(0, window.innerHeight * 1.5);
        await new Promise(resolve => setTimeout(resolve, 1_500));
        return true;
      }, null), deadline, () => this.page.close());
      scrollCount++;
      if (Object.values(await this.getSafetyState(deadline)).some(Boolean)) break;
      const next = await withCancellation(this.page.evaluate(readLiveFeed, limits.maxCharacters), deadline, () => this.page.close());
      if (typeof next !== 'object' || next === null || typeof Reflect.get(next, 'html') !== 'string') throw new Error('Invalid page content');
      if (!isAllowedNavigationUrl(String(Reflect.get(next, 'currentUrl')))) throw new NavigationBlockedError();
      discovery.add(String(Reflect.get(next,'html')));
      if(discovery.shouldRefresh(round+1))break;
      }
      if(discovery.count>=MAX_DISCOVERED_POSTS)break;
    }
    if(limits.stats)Object.assign(limits.stats,{seenCount:discovery.count,scrollCount,refreshCount});
    return discovery.html;
  }

  async close(): Promise<void> {
    await this.page.close();
  }
}

export function createCloudflareReadonlyBrowser(
  browser: CloudflareBrowserLike,
  existingContext?: CloudflareContextLike,
): ReadonlyBrowserAdapter {
  let contextPromise: Promise<CloudflareContextLike> | undefined = existingContext
    ? Promise.resolve(existingContext)
    : undefined;
  return {
    async newPage(deadline) {
      contextPromise ??= browser.newContext();
      const context = await withCancellation(contextPromise, deadline, () => browser.close());
      const rawPage = await withCancellation(context.newPage(), deadline, () => browser.close());
      const page = new CloudflareReadonlyPage(rawPage);
      await withCancellation(page.installRequestGuard(), deadline, () => rawPage.close());
      return {
        goto: (url, operationDeadline) => page.goto(url, operationDeadline),
        getSafetyState: (operationDeadline) => page.getSafetyState(operationDeadline),
        content: (operationDeadline, limits) => page.content(operationDeadline, limits),
        close: () => page.close(),
      };
    },
    close: () => browser.close(),
  };
}

export function createCloudflareReadonlyPage(page: CloudflarePageLike): ReadonlyPageAdapter {
  const adapter = new CloudflareReadonlyPage(page);
  return {
    goto: (url, deadline) => adapter.goto(url, deadline),
    getSafetyState: (deadline) => adapter.getSafetyState(deadline),
    content: (deadline, limits) => adapter.content(deadline, limits),
    close: () => adapter.close(),
  };
}
