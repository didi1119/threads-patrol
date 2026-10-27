import { Parser } from "htmlparser2";
import { parseHTML } from "linkedom";

export const MAX_EXTRACT_HTML_CHARACTERS = 2_000_000;
export const MAX_CANDIDATE_NODES = 250;
export const MAX_DOM_DEPTH = 64;
export const MAX_DOM_NODES = 10_000;
export const MAX_POST_TEXT_CHARACTERS = 5_000;
export const MAX_RELEVANT_ATTRIBUTE_CHARACTERS = 2_048;
export const MAX_AUTHOR_HANDLE_CHARACTERS = 64;
export const MAX_EXTRACTED_CANDIDATES = 40;

export class ExtractionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionLimitError";
  }
}

export interface VisibleMetrics {
  likes: number;
  replies: number;
}

export interface ScoutCandidate {
  sourcePostId: string;
  sourceUrl: string;
  authorHandle: string;
  text: string;
  discoveredAt: string;
  visibleMetrics: VisibleMetrics;
}

export interface ExtractConfig {
  ownHandle: string;
  excludedHandles?: readonly string[];
  seenUrls: readonly string[];
  timeWindowMs: number;
  now: Date;
  maxCandidates?: number;
  minLikes?: number;
}

interface ParsedPostUrl {
  url: string;
  handle: string;
  postId: string;
}

const POST_PATH = /^\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)$/;
const THREADS_AUTHORITY = /^https:\/\/(?:www\.)?threads\.com(?:\/|$)/i;

export function hasAllowedThreadsAuthority(rawUrl: string): boolean {
  return THREADS_AUTHORITY.test(rawUrl);
}

function parseThreadsPostUrl(rawUrl: string): ParsedPostUrl | null {
  try {
    if (!hasAllowedThreadsAuthority(rawUrl)) return null;
    const parsed = new URL(rawUrl);
    if (
      parsed.protocol !== "https:" ||
      (parsed.hostname !== "threads.com" && parsed.hostname !== "www.threads.com") ||
      parsed.port !== "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }

    const match = POST_PATH.exec(parsed.pathname);
    if (!match) return null;

    const [, rawHandle, postId] = match;
    if (postId.length > 160) return null;
    const handle = rawHandle.toLowerCase();
    return {
      url: `https://www.threads.com/@${handle}/post/${postId}`,
      handle,
      postId,
    };
  } catch {
    return null;
  }
}

export function normalizeThreadsPostUrl(rawUrl: string): string | null {
  return parseThreadsPostUrl(rawUrl)?.url ?? null;
}

function parseVisibleCount(rawValue: string | null): number {
  if (!rawValue) return 0;
  const normalized = rawValue.trim().replaceAll(",", "").toUpperCase();
  const match = /^(\d+(?:\.\d+)?)([KM])?$/.exec(normalized);
  if (!match) return 0;

  const multiplier = match[2] === "K" ? 1_000 : match[2] === "M" ? 1_000_000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

interface BoundedTreeNode {
  childNodes?: ArrayLike<BoundedTreeNode>;
}

export interface FeedPreflightResult {
  nodes: number;
  maxDepth: number;
  candidateNodes: number;
}

export function preflightFeedHtml(html: string): FeedPreflightResult {
  if (html.length > MAX_EXTRACT_HTML_CHARACTERS) {
    throw new ExtractionLimitError("HTML exceeds extraction limit");
  }

  let nodes = 1;
  let depth = 0;
  let maxDepth = 0;
  let candidateNodes = 0;
  const countNode = () => {
    nodes += 1;
    if (nodes > MAX_DOM_NODES) {
      throw new ExtractionLimitError("DOM node limit exceeded");
    }
  };
  const parser = new Parser({
    onopentag(_name, attributes) {
      countNode();
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      if (maxDepth > MAX_DOM_DEPTH) {
        throw new ExtractionLimitError("DOM depth limit exceeded");
      }
      if (Object.hasOwn(attributes, "data-thread-post")) {
        candidateNodes += 1;
        if (candidateNodes > MAX_CANDIDATE_NODES) {
          throw new ExtractionLimitError("Candidate node limit exceeded");
        }
      }
    },
    onclosetag() {
      depth = Math.max(0, depth - 1);
    },
    ontext(text) {
      if (text.length > 0) countNode();
    },
    oncomment() {
      countNode();
    },
    onprocessinginstruction() {
      countNode();
    },
  }, {
    decodeEntities: true,
    lowerCaseAttributeNames: true,
    lowerCaseTags: true,
    recognizeSelfClosing: true,
  });
  parser.write(html);
  parser.end();
  return { nodes, maxDepth, candidateNodes };
}

function assertDomDepth(root: BoundedTreeNode): void {
  const pending: Array<{ node: BoundedTreeNode; depth: number }> = [{ node: root, depth: 0 }];
  let visitedNodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    visitedNodes += 1;
    if (visitedNodes > MAX_DOM_NODES) {
      throw new ExtractionLimitError("DOM node limit exceeded");
    }
    if (current.depth > MAX_DOM_DEPTH) {
      throw new ExtractionLimitError("DOM depth limit exceeded");
    }
    for (const child of Array.from(current.node.childNodes ?? [])) {
      pending.push({ node: child, depth: current.depth + 1 });
    }
  }
}

function assertAttributeLimit(value: string | null, maxCharacters: number): void {
  if (value !== null && value.length > maxCharacters) {
    throw new ExtractionLimitError("Attribute limit exceeded");
  }
}

/**
 * Extracts the stable local contract made of data-thread-post, data-post-url,
 * data-post-text, data-posted-at, data-likes, and data-replies attributes. It
 * intentionally does not depend on Threads' current CSS class names.
 */
export interface ExtractDependencies {
  parseHtml?: typeof parseHTML;
}

export function extractCandidates(
  html: string,
  config: ExtractConfig,
  dependencies: ExtractDependencies = {},
): ScoutCandidate[] {
  preflightFeedHtml(html);
  if (!Number.isFinite(config.timeWindowMs) || config.timeWindowMs < 0) {
    throw new Error("timeWindowMs must be a non-negative finite number");
  }
  if (Number.isNaN(config.now.getTime())) throw new Error("now must be a valid date");
  const candidateLimit=config.maxCandidates??MAX_EXTRACTED_CANDIDATES;
  if(!Number.isInteger(candidateLimit)||candidateLimit<1||candidateLimit>120)throw new Error('Invalid candidate budget');

  const { document } = (dependencies.parseHtml ?? parseHTML)(html);
  assertDomDepth(document as unknown as BoundedTreeNode);
  const postNodes = document.querySelectorAll("[data-thread-post]");
  if (postNodes.length > MAX_CANDIDATE_NODES) {
    throw new ExtractionLimitError("Candidate node limit exceeded");
  }
  const ownHandle = normalizeHandle(config.ownHandle);
  const excludedHandles = new Set([ownHandle, ...(config.excludedHandles ?? []).map(normalizeHandle)]);
  const seenUrls = new Set(
    config.seenUrls
      .map(normalizeThreadsPostUrl)
      .filter((url): url is string => url !== null),
  );
  const discoveredAt = config.now.toISOString();
  const candidates: ScoutCandidate[] = [];
  const emittedUrls = new Set<string>();

  for (const post of postNodes) {
    if (candidates.length >= candidateLimit) break;

    const urlElement = post.querySelector("[data-post-url]");
    const postedAtElement = post.querySelector("[data-posted-at]");
    const likesElement = post.querySelector("[data-likes]");
    const repliesElement = post.querySelector("[data-replies]");
    assertAttributeLimit(
      post.getAttribute("data-author-handle"),
      MAX_AUTHOR_HANDLE_CHARACTERS,
    );
    assertAttributeLimit(urlElement?.getAttribute("href") ?? null, MAX_RELEVANT_ATTRIBUTE_CHARACTERS);
    assertAttributeLimit(postedAtElement?.getAttribute("datetime") ?? null, 64);
    assertAttributeLimit(likesElement?.getAttribute("data-likes") ?? null, 32);
    assertAttributeLimit(repliesElement?.getAttribute("data-replies") ?? null, 32);
    const text = post.querySelector("[data-post-text]")?.textContent?.trim() ?? "";
    if (text.length > MAX_POST_TEXT_CHARACTERS) {
      throw new ExtractionLimitError("Post text limit exceeded");
    }

    if (post.hasAttribute("data-promoted")) continue;

    const rawUrl = urlElement?.getAttribute("href");
    const parsedUrl = rawUrl ? parseThreadsPostUrl(rawUrl) : null;
    if (!parsedUrl || seenUrls.has(parsedUrl.url) || emittedUrls.has(parsedUrl.url)) continue;

    const declaredAuthor = normalizeHandle(post.getAttribute("data-author-handle") ?? "");
    const urlAuthor = normalizeHandle(parsedUrl.handle);
    if (!declaredAuthor || declaredAuthor !== urlAuthor || excludedHandles.has(urlAuthor)) continue;

    const postedAtValue = postedAtElement?.getAttribute("datetime");
    const postedAt = postedAtValue ? new Date(postedAtValue).getTime() : Number.NaN;
    const ageMs = config.now.getTime() - postedAt;
    if (!Number.isFinite(postedAt) || ageMs < 0 || ageMs > config.timeWindowMs) continue;

    if (!text || /^\d+\s*(?:s|m|h|d|w|秒|分鐘|小時|天|週|周)$/i.test(text)) continue;

    const likes = parseVisibleCount(likesElement?.getAttribute("data-likes") ?? null);
    const replies = parseVisibleCount(repliesElement?.getAttribute("data-replies") ?? null);
    if (!Number.isSafeInteger(likes) || !Number.isSafeInteger(replies)) continue;
    if (likes < (config.minLikes ?? 0)) continue;

    candidates.push({
      sourcePostId: parsedUrl.postId,
      sourceUrl: parsedUrl.url,
      authorHandle: parsedUrl.handle,
      text,
      discoveredAt,
      visibleMetrics: {
        likes,
        replies,
      },
    });
    emittedUrls.add(parsedUrl.url);
  }

  return candidates;
}
