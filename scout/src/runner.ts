import {
  ExtractionLimitError,
  MAX_EXTRACTED_CANDIDATES,
  MAX_EXTRACT_HTML_CHARACTERS,
  extractCandidates,
  hasAllowedThreadsAuthority,
  type ExtractConfig,
  type ScoutCandidate,
} from "./extract.js";
import type {DiscoveryStats} from './feed-discovery.js';

export const MAX_RUN_DURATION_MS = 25 * 60 * 1000;
export const MAX_UNIQUE_POSTS = MAX_EXTRACTED_CANDIDATES;
export const MAX_WINDOWS_PER_DAY = 4;
export const MAX_FEED_HTML_CHARACTERS = MAX_EXTRACT_HTML_CHARACTERS;
export const DEFAULT_OPERATING_TIME_ZONE = "Asia/Taipei";
export const CLEANUP_TIMEOUT_MS = 2_000;

export class NavigationBlockedError extends Error {
  constructor() {
    super("Navigation was blocked by the read-only adapter");
    this.name = "NavigationBlockedError";
  }
}

export type SafetyState = Partial<{
  loginPrompt: boolean;
  checkpoint: boolean;
  captcha: boolean;
  challenge: boolean;
  unexpectedConsent: boolean;
}>;

export interface OperationDeadline {
  /**
   * Adapter operations must subscribe to signal and abort underlying work no
   * later than deadlineMs. Returning to the caller without cancelling the
   * browser operation is non-conforming.
   */
  deadlineMs: number;
  signal: AbortSignal;
}

export interface ReadonlyPageAdapter {
  goto(url: string, deadline: OperationDeadline): Promise<{ status: number; finalUrl: string }>;
  getSafetyState(deadline: OperationDeadline): Promise<SafetyState>;
  content(
    deadline: OperationDeadline,
    limits: { maxCharacters: number; stats?: DiscoveryStats },
  ): Promise<string>;
  close(): Promise<void>;
}

export interface ReadonlyBrowserAdapter {
  newPage(deadline: OperationDeadline): Promise<ReadonlyPageAdapter>;
  close(): Promise<void>;
}

export interface ScoutRunConfig extends ExtractConfig {
  targetUrl: string;
  maxDurationMs?: number;
}

export type StopReason =
  | "LOGIN_PROMPT"
  | "CHECKPOINT"
  | "CAPTCHA"
  | "CHALLENGE"
  | "UNEXPECTED_CONSENT"
  | "HTTP_429"
  | "HTTP_ERROR"
  | "NAVIGATION_BLOCKED"
  | "CONTENT_LIMIT"
  | "TIME_LIMIT";

export type ScoutRunResult =
  | { status: "completed"; candidates: ScoutCandidate[]; discovery?:DiscoveryStats }
  | { status: "stopped"; reason: StopReason; candidates: [] };

export interface RunnerDependencies {
  clock?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const SAFETY_PRIORITY: readonly [keyof SafetyState, StopReason][] = [
  ["loginPrompt", "LOGIN_PROMPT"],
  ["checkpoint", "CHECKPOINT"],
  ["captcha", "CAPTCHA"],
  ["challenge", "CHALLENGE"],
  ["unexpectedConsent", "UNEXPECTED_CONSENT"],
];

function safetyStopReason(safety: SafetyState): StopReason | null {
  for (const [signal, reason] of SAFETY_PRIORITY) {
    if (safety[signal]) return reason;
  }
  return null;
}

function isKnownMetaHostname(hostname: string): boolean {
  return new Set([
    "threads.com",
    "www.threads.com",
    "instagram.com",
    "www.instagram.com",
    "accounts.instagram.com",
    "facebook.com",
    "www.facebook.com",
    "m.facebook.com",
    "meta.com",
    "www.meta.com",
  ]).has(hostname);
}

export function safetyStopReasonFromUrl(rawUrl: string): StopReason | null {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      !isKnownMetaHostname(url.hostname)
    ) {
      return null;
    }
    const route = url.pathname.toLowerCase();
    if (/(?:^|[\/_-])captcha(?:[\/_?=-]|$)/.test(route)) return "CAPTCHA";
    if (/(?:^|[\/_-])checkpoint(?:[\/_?=-]|$)/.test(route)) return "CHECKPOINT";
    if (/(?:^|[\/_-])challenge(?:[\/_?=-]|$)/.test(route)) return "CHALLENGE";
    if (/(?:^|[\/_-])(?:login|signin)(?:[\/_?=-]|$)/.test(route)) return "LOGIN_PROMPT";
    if (/(?:^|[\/_-])consent(?:[\/_?=-]|$)/.test(route)) return "UNEXPECTED_CONSENT";
    return null;
  } catch {
    return null;
  }
}

async function closePageBestEffort(page: ReadonlyPageAdapter): Promise<void> {
  await Promise.resolve().then(() => page.close()).catch(() => undefined);
}

export function isAllowedNavigationUrl(rawUrl: string): boolean {
  try {
    if (!hasAllowedThreadsAuthority(rawUrl)) return false;
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "threads.com" && url.hostname !== "www.threads.com") ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      return false;
    }

    if (url.pathname === "/" && url.search === "") return true;
    if (url.pathname === "/search") return true;
    return /^\/@[A-Za-z0-9._]+\/post\/[A-Za-z0-9_-]+$/.test(url.pathname) && url.search === "";
  } catch {
    return false;
  }
}

function elapsed(startedAt: number, clock: () => number, maxDurationMs: number): boolean {
  return clock() - startedAt >= maxDurationMs;
}

export async function runScout(
  browser: ReadonlyBrowserAdapter,
  config: ScoutRunConfig,
  dependencies: RunnerDependencies = {},
): Promise<ScoutRunResult> {
  if (!isAllowedNavigationUrl(config.targetUrl)) {
    throw new Error("Navigation URL is not allowed");
  }
  const maxDurationMs = config.maxDurationMs ?? MAX_RUN_DURATION_MS;
  if (
    !Number.isFinite(maxDurationMs) ||
    !Number.isInteger(maxDurationMs) ||
    maxDurationMs <= 0 ||
    maxDurationMs > MAX_RUN_DURATION_MS
  ) {
    throw new Error("Invalid run duration");
  }

  const clock = dependencies.clock ?? Date.now;
  const setTimer = dependencies.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = dependencies.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const startedAt = clock();
  const abortController = new AbortController();
  const deadline: OperationDeadline = {
    deadlineMs: startedAt + maxDurationMs,
    signal: abortController.signal,
  };
  const timeLimitResult: ScoutRunResult = {
    status: "stopped",
    reason: "TIME_LIMIT",
    candidates: [],
  };
  let timerHandle: unknown;
  const timeout = new Promise<ScoutRunResult>((resolve) => {
    timerHandle = setTimer(() => {
      resolve(timeLimitResult);
      abortController.abort();
    }, maxDurationMs);
  });
  let page: ReadonlyPageAdapter | undefined;

  try {
    const execute = async (): Promise<ScoutRunResult> => {
      page = await browser.newPage(deadline);
      if (deadline.signal.aborted || elapsed(startedAt, clock, maxDurationMs)) {
        await closePageBestEffort(page);
        return timeLimitResult;
      }

      const response = await page.goto(config.targetUrl, deadline);
      const redirectSafetyStop = safetyStopReasonFromUrl(response.finalUrl);
      if (redirectSafetyStop) {
        return { status: "stopped", reason: redirectSafetyStop, candidates: [] };
      }
      if (!isAllowedNavigationUrl(response.finalUrl)) {
        return { status: "stopped", reason: "NAVIGATION_BLOCKED", candidates: [] };
      }
      if (response.status === 429) {
        return { status: "stopped", reason: "HTTP_429", candidates: [] };
      }
      if (
        !Number.isInteger(response.status) ||
        response.status < 200 ||
        response.status >= 300
      ) {
        return { status: "stopped", reason: "HTTP_ERROR", candidates: [] };
      }
      if (deadline.signal.aborted || elapsed(startedAt, clock, maxDurationMs)) return timeLimitResult;

      const safety = await page.getSafetyState(deadline);
      const preContentStop = safetyStopReason(safety);
      if (preContentStop) return { status: "stopped", reason: preContentStop, candidates: [] };
      if (deadline.signal.aborted || elapsed(startedAt, clock, maxDurationMs)) return timeLimitResult;

      let html: string;
      const stats={} as DiscoveryStats;
      try {
        html = await page.content(deadline, {
          maxCharacters: MAX_FEED_HTML_CHARACTERS,
          stats,
        });
      } catch (error) {
        if (error instanceof NavigationBlockedError) {
          return { status: "stopped", reason: "NAVIGATION_BLOCKED", candidates: [] };
        }
        throw error;
      }
      if (deadline.signal.aborted || elapsed(startedAt, clock, maxDurationMs)) return timeLimitResult;
      if (html.length > MAX_FEED_HTML_CHARACTERS) {
        return { status: "stopped", reason: "CONTENT_LIMIT", candidates: [] };
      }

      const postContentSafety = await page.getSafetyState(deadline);
      const postContentStop = safetyStopReason(postContentSafety);
      if (postContentStop) return { status: "stopped", reason: postContentStop, candidates: [] };
      if (deadline.signal.aborted || elapsed(startedAt, clock, maxDurationMs)) return timeLimitResult;

      let candidates: ScoutCandidate[];
      try {
        candidates = extractCandidates(html, config);
      } catch (error) {
        if (error instanceof ExtractionLimitError) {
          return { status: "stopped", reason: "CONTENT_LIMIT", candidates: [] };
        }
        throw error;
      }
      if (deadline.signal.aborted || elapsed(startedAt, clock, maxDurationMs)) return timeLimitResult;
      return { status: "completed", candidates, ...(Number.isInteger(stats.seenCount)?{discovery:stats}:{}) };
    };

    try {
      return await Promise.race([execute(), timeout]);
    } catch (error) {
      if (deadline.signal.aborted) return timeLimitResult;
      throw error;
    }
  } finally {
    abortController.abort();
    let cleanupTimerHandle: unknown;
    const cleanupTimeout = new Promise<void>((resolve) => {
      try {
        cleanupTimerHandle = setTimer(resolve, CLEANUP_TIMEOUT_MS);
      } catch {
        resolve();
      }
    });
    try {
      const cleanup = Promise.allSettled([
        Promise.resolve().then(() => page?.close()),
        Promise.resolve().then(() => browser.close()),
      ]);
      await Promise.race([cleanup, cleanupTimeout]);
    } finally {
      try {
        clearTimer(cleanupTimerHandle);
      } catch {
        // Cleanup is best-effort and must never replace the primary result.
      }
      try {
        clearTimer(timerHandle);
      } catch {
        // Cleanup is best-effort and must never replace the primary result.
      }
    }
  }
}

export type ScheduleValidation =
  | { valid: true }
  | { valid: false; reason: "INVALID_WINDOW" }
  | { valid: false; reason: "INVALID_TIME_ZONE"; timeZone: string }
  | { valid: false; reason: "DUPLICATE_WINDOW"; timestamp: string }
  | { valid: false; reason: "TOO_MANY_WINDOWS_PER_DAY"; day: string };

function operatingDay(window: Date, formatter: Intl.DateTimeFormat): string {
  const parts = new Map(
    formatter
      .formatToParts(window)
      .filter((part) => part.type === "year" || part.type === "month" || part.type === "day")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

export function validateScheduleWindows(
  windows: readonly Date[],
  timeZone = DEFAULT_OPERATING_TIME_ZONE,
): ScheduleValidation {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return { valid: false, reason: "INVALID_TIME_ZONE", timeZone };
  }

  const counts = new Map<string, number>();
  const timestamps = new Set<number>();
  for (const window of windows) {
    if (!(window instanceof Date) || Number.isNaN(window.getTime())) {
      return { valid: false, reason: "INVALID_WINDOW" };
    }
    const timestamp = window.getTime();
    if (timestamps.has(timestamp)) {
      return {
        valid: false,
        reason: "DUPLICATE_WINDOW",
        timestamp: window.toISOString(),
      };
    }
    timestamps.add(timestamp);

    const day = operatingDay(window, formatter);
    const count = (counts.get(day) ?? 0) + 1;
    if (count > MAX_WINDOWS_PER_DAY) {
      return { valid: false, reason: "TOO_MANY_WINDOWS_PER_DAY", day };
    }
    counts.set(day, count);
  }
  return { valid: true };
}
