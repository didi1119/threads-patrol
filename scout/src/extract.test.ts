import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import {
  extractCandidates,
  normalizeThreadsPostUrl,
} from "./extract.js";

const MAX_EXTRACT_HTML_CHARACTERS = 2_000_000;
const MAX_CANDIDATE_NODES = 250;
const MAX_DOM_DEPTH = 64;
const MAX_DOM_NODES = 10_000;
const MAX_POST_TEXT_CHARACTERS = 5_000;

const fixture = readFileSync(
  fileURLToPath(new URL("../fixtures/recommended-feed.html", import.meta.url)),
  "utf8",
);

describe("extractCandidates", () => {
 it('filters by the configured strict thousand-like floor',()=>{
 const html=[999,1000,1001].map(n=>`<article data-thread-post data-author-handle="a"><a data-post-url href="https://threads.com/@a/post/T${n}"></a><p data-post-text>日常</p><time data-posted-at datetime="2026-09-28T11:59:00Z"></time><span data-likes="${n}"></span></article>`).join('');
 expect(extractCandidates(html,{ownHandle:'bfh9023',seenUrls:[],now:new Date('2026-09-28T12:00:00Z'),timeWindowMs:3600000,minLikes:1001}).map(c=>c.sourcePostId)).toEqual(['T1001']);
 });
  it('excludes both the scout account and our brand and timestamp-only noise',()=>{
    const html=['bfh9023','best_forest_house','daily','noise'].map(h=>`<article data-thread-post data-author-handle="${h}"><a data-post-url href="https://www.threads.com/@${h}/post/T_${h}"></a><p data-post-text>${h==='noise'?'1d':'今天只想發呆'}</p><time data-posted-at datetime="2026-09-28T11:59:00Z"></time></article>`).join('');
    expect(extractCandidates(html,{ownHandle:'bfh9023',excludedHandles:['@Best_Forest_House'],seenUrls:[],now:new Date('2026-09-28T12:00:00Z'),timeWindowMs:3600000}).map(c=>c.authorHandle)).toEqual(['daily']);
  });
  it('supports a bounded deep discovery budget while preserving default short-run compatibility',()=>{
    const html=Array.from({length:125},(_,i)=>`<article data-thread-post data-author-handle="a"><a data-post-url href="https://www.threads.com/@a/post/P${i}"></a><p data-post-text>普通日常可接話</p><time data-posted-at datetime="2026-09-28T11:59:00Z"></time></article>`).join('');
    const config={ownHandle:'bfh9023',seenUrls:[],timeWindowMs:3600000,now:new Date('2026-09-28T12:00:00Z'),maxCandidates:120};
    expect(extractCandidates(html,config)).toHaveLength(120);
  });
  it("keeps compatible posts when another permalink or metric exceeds workbench bounds", () => {
    const make=(id:string,count:string)=>`<article data-thread-post data-author-handle="author"><a data-post-url href="https://www.threads.com/@author/post/${id}"></a><p data-post-text>可接話的日常</p><time data-posted-at datetime="2026-09-28T11:59:00.000Z"></time><i data-likes="${count}"></i></article>`;
    const result=extractCandidates(make('D-valid','12')+make('a'.repeat(161),'10')+make('D-overflow','99999999999999999999999999999999'),{ownHandle:'quietforest',seenUrls:[],timeWindowMs:3600000,now:new Date('2026-09-28T12:00:00.000Z')});
    expect(result.map(c=>c.sourcePostId)).toEqual(['D-valid']);
  });
  it("returns only the eligible recommended post", () => {
    expect(
      extractCandidates(fixture, {
        ownHandle: "@QuietForest",
        seenUrls: ["https://threads.com/@seen-author/post/D-seen"],
        timeWindowMs: 60 * 60 * 1000,
        now: new Date("2026-09-28T12:00:00.000Z"),
      }),
    ).toEqual([
      {
        sourcePostId: "D-example",
        sourceUrl: "https://www.threads.com/@author/post/D-example",
        authorHandle: "author",
        text: "要懂得犒賞自己",
        discoveredAt: "2026-09-28T12:00:00.000Z",
        visibleMetrics: { likes: 1200, replies: 80 },
      },
    ]);
  });

  it("rejects unsafe or non-post URLs and canonicalizes the approved host", () => {
    expect(normalizeThreadsPostUrl("https://threads.com/@safe_user/post/D-123")).toBe(
      "https://www.threads.com/@safe_user/post/D-123",
    );

    for (const unsafeUrl of [
      "javascript:alert(1)",
      "data:text/html,hello",
      "http://www.threads.com/@author/post/D-1",
      "https://evil.example/@author/post/D-1",
      "https://www.threads.com/@author",
      "https://www.threads.com/@author/post/D-1/extra",
      "https://www.threads.com:443/@author/post/D-1",
      "https://user@www.threads.com/@author/post/D-1",
      "https://threadѕ.com/@author/post/D-1",
      "https://www.threads.com/%40author/post/D-1",
      "https://www.threads.com/@author/%70ost/D-1",
      "https://www.threads.com/@author/post/D-1#fragment",
    ]) {
      expect(normalizeThreadsPostUrl(unsafeUrl)).toBeNull();
    }

    expect(normalizeThreadsPostUrl("HTTPS://THREADS.COM/@Author/post/D-1")).toBe(
      "https://www.threads.com/@author/post/D-1",
    );
  });

  it("canonicalizes handle casing so seen URLs cannot be bypassed", () => {
    expect(normalizeThreadsPostUrl("https://www.threads.com/@Author.Name/post/D-123")).toBe(
      "https://www.threads.com/@author.name/post/D-123",
    );
  });

  it("rejects oversized HTML before parsing", () => {
    expect(() => extractCandidates("x".repeat(MAX_EXTRACT_HTML_CHARACTERS + 1), {
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    })).toThrow("HTML exceeds extraction limit");
  });

  it("rejects a feed with too many candidate nodes", () => {
    const html = "<article data-thread-post></article>".repeat(MAX_CANDIDATE_NODES + 1);
    expect(() => extractCandidates(html, {
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    })).toThrow("Candidate node limit exceeded");
  });

  it("rejects DOM nesting beyond the bounded depth", () => {
    const html = `${"<div>".repeat(MAX_DOM_DEPTH + 1)}x${"</div>".repeat(MAX_DOM_DEPTH + 1)}`;
    expect(() => extractCandidates(html, {
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    })).toThrow("DOM depth limit exceeded");
  });

  it("rejects too many shallow DOM nodes", () => {
    const html = "<div></div>".repeat(MAX_DOM_NODES + 1);
    expect(() => extractCandidates(html, {
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    })).toThrow("DOM node limit exceeded");
  });

  it("rejects streaming preflight limits before invoking the DOM parser", () => {
    const parseHtml = vi.fn(parseHTML);
    const config = {
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    };

    expect(() => extractCandidates(
      "<div></div>".repeat(MAX_DOM_NODES + 1),
      config,
      { parseHtml },
    )).toThrow("DOM node limit exceeded");
    expect(parseHtml).not.toHaveBeenCalled();

    extractCandidates(fixture, config, { parseHtml });
    expect(parseHtml).toHaveBeenCalledTimes(1);
  });

  it("rejects overlong visible text and relevant attributes", () => {
    const config = {
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    };
    const longText = `<article data-thread-post data-author-handle="author">
      <a data-post-url href="https://www.threads.com/@author/post/D-long">post</a>
      <p data-post-text>${"x".repeat(MAX_POST_TEXT_CHARACTERS + 1)}</p>
      <time data-posted-at datetime="2026-09-28T11:30:00.000Z"></time>
    </article>`;
    const longAttribute = `<article data-thread-post data-author-handle="${"a".repeat(65)}"></article>`;

    expect(() => extractCandidates(longText, config)).toThrow("Post text limit exceeded");
    expect(() => extractCandidates(longAttribute, config)).toThrow("Attribute limit exceeded");
  });

  it("stops iterating after 40 unique candidates", () => {
    const validPosts = Array.from({ length: 40 }, (_, index) => `
      <article data-thread-post data-author-handle="author${index}">
        <a data-post-url href="https://www.threads.com/@author${index}/post/D-${index}">post</a>
        <p data-post-text>Post ${index}</p>
        <time data-posted-at datetime="2026-09-28T11:30:00.000Z"></time>
      </article>`).join("");
    const unprocessedOverlongPost = `<article data-thread-post data-author-handle="authorlast">
      <a data-post-url href="https://www.threads.com/@authorlast/post/D-last">post</a>
      <p data-post-text>${"x".repeat(MAX_POST_TEXT_CHARACTERS + 1)}</p>
      <time data-posted-at datetime="2026-09-28T11:30:00.000Z"></time>
    </article>`;

    expect(extractCandidates(validPosts + unprocessedOverlongPost, {
      ownHandle: "quietforest",
      seenUrls: [],
      timeWindowMs: 60 * 60 * 1000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    })).toHaveLength(40);
  });
});
