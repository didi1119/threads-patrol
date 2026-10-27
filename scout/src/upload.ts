import { normalizeThreadsPostUrl, type VisibleMetrics } from "./extract.js";

export const MAX_UPLOAD_TEXT_CHARACTERS = 5_000;
export const MAX_UPLOAD_URL_CHARACTERS = 2_048;
export const MAX_UPLOAD_CANDIDATES = 40;
export const MAX_PUBLIC_METRIC = 1_000_000_000;

export interface ScoutUploadPost {
  postUrl: string;
  visibleText: string;
  discoveredAt: string;
  publicMetrics: VisibleMetrics;
}

export interface ScoutUploader {
  upload(payload: readonly ScoutUploadPost[]): Promise<void>;
}

type PlainRecord = Record<PropertyKey, unknown>;

function requirePlainRecord(value: unknown, label: string): PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must contain plain data`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must contain plain data`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.hasOwn(descriptors, "toJSON")) {
    throw new Error(`${label} must contain plain data`);
  }
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get || descriptor.set) {
      throw new Error(`${label} must contain plain data`);
    }
  }
  return value as PlainRecord;
}

function ownValue(record: PlainRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function requireText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_UPLOAD_TEXT_CHARACTERS
  ) {
    throw new Error("Visible text must be a bounded primitive string");
  }
  return value;
}

function requireIsoTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error("Timestamp must be canonical ISO 8601");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error("Timestamp must be canonical ISO 8601");
  }
  return value;
}

function requireMetric(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_PUBLIC_METRIC
  ) {
    throw new Error(`${label} must be a bounded non-negative safe integer in plain data`);
  }
  return value;
}

export function sanitizeUploadPayload(
  candidates: readonly unknown[],
): ScoutUploadPost[] {
  if (!Array.isArray(candidates) || candidates.length > MAX_UPLOAD_CANDIDATES) {
    throw new Error("Upload candidate limit exceeded");
  }
  const arrayDescriptors = Object.getOwnPropertyDescriptors(candidates);
  const expectedKeys = new Set(["length"]);
  const candidateValues: unknown[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const key = String(index);
    expectedKeys.add(key);
    const descriptor = arrayDescriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      throw new Error("Candidates must be a dense plain data array");
    }
    candidateValues.push(descriptor.value);
  }
  if (
    Object.keys(arrayDescriptors).some((key) => !expectedKeys.has(key)) ||
    Object.getOwnPropertySymbols(candidates).length > 0
  ) {
    throw new Error("Candidates must be a dense plain data array");
  }

  const payload: ScoutUploadPost[] = [];
  for (const candidateValue of candidateValues) {
    const candidate = requirePlainRecord(candidateValue, "Candidate");
    const sourceUrl = ownValue(candidate, "sourceUrl");
    if (typeof sourceUrl !== "string" || sourceUrl.length > MAX_UPLOAD_URL_CHARACTERS) {
      throw new Error("Candidate URL must be a bounded primitive string");
    }
    const postUrl = normalizeThreadsPostUrl(sourceUrl);
    if (!postUrl) throw new Error("Candidate contains an invalid Threads post URL");

    const metrics = requirePlainRecord(ownValue(candidate, "visibleMetrics"), "Metrics");
    const visibleText = requireText(ownValue(candidate, "text"));
    const discoveredAt = requireIsoTimestamp(ownValue(candidate, "discoveredAt"));
    const likes = requireMetric(ownValue(metrics, "likes"), "Likes");
    const replies = requireMetric(ownValue(metrics, "replies"), "Replies");

    payload.push({
      postUrl,
      visibleText,
      discoveredAt,
      publicMetrics: {
        likes,
        replies,
      },
    });
  }
  return payload;
}
