import { describe, expect, it } from "vitest";
import {
  MAX_CIPHERTEXT_BASE64_CHARACTERS,
  MAX_ENCRYPTED_ENVELOPE_CHARACTERS,
  MAX_STORAGE_STATE_CHARACTERS,
  decryptStorageState,
  encryptStorageState,
} from "./state-crypto.js";

const key = Buffer.alloc(32, 7).toString("base64");
const otherKey = Buffer.alloc(32, 8).toString("base64");
const state = JSON.stringify({
  cookies: [{ name: "session", value: "private", domain: ".threads.com", path: "/" }],
  origins: [],
});

describe("encrypted storage state", () => {
  it("round-trips JSON with a fresh IV and a versioned envelope", async () => {
    const first = await encryptStorageState(state, key);
    const second = await encryptStorageState(state, key);

    expect(first).not.toBe(second);
    expect(JSON.parse(first)).toMatchObject({ version: 1 });
    expect(first).not.toContain("private");
    await expect(decryptStorageState(first, key)).resolves.toBe(state);
    await expect(decryptStorageState(second, key)).resolves.toBe(state);
  });

  it.each([
    "",
    "not-base64",
    Buffer.alloc(31).toString("base64"),
    Buffer.alloc(33).toString("base64"),
  ])("rejects a key that is not exactly 32 bytes: %s", async (badKey) => {
    await expect(encryptStorageState(state, badKey)).rejects.toThrow("32-byte");
  });

  it("fails closed for tampering and a wrong key", async () => {
    const envelope = JSON.parse(await encryptStorageState(state, key)) as {
      version: number;
      iv: string;
      ciphertext: string;
    };
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] ^= 1;
    envelope.ciphertext = bytes.toString("base64");

    await expect(decryptStorageState(JSON.stringify(envelope), key)).rejects.toThrow(
      "Unable to decrypt storage state",
    );
    await expect(
      decryptStorageState(await encryptStorageState(state, key), otherKey),
    ).rejects.toThrow("Unable to decrypt storage state");
  });

  it.each([
    "null",
    "[]",
    "{}",
    JSON.stringify({ version: 2, iv: "AA==", ciphertext: "AA==" }),
    JSON.stringify({ version: 1, iv: "AA==", ciphertext: "AA==", extra: true }),
  ])("rejects invalid envelopes: %s", async (envelope) => {
    await expect(decryptStorageState(envelope, key)).rejects.toThrow();
  });

  it.each(["", "null", "[]", "not-json", JSON.stringify({ cookies: "secret", origins: [] })])(
    "rejects malformed storage-state input: %s",
    async (input) => {
      await expect(encryptStorageState(input, key)).rejects.toThrow("storage state");
    },
  );

  it("rejects oversized plaintext before encryption", async () => {
    const oversized = JSON.stringify({ cookies: [], origins: [], padding: "x".repeat(MAX_STORAGE_STATE_CHARACTERS) });
    await expect(encryptStorageState(oversized, key)).rejects.toThrow("too large");
  });

  it("rejects oversized envelopes and base64 fields before decoding", async () => {
    await expect(
      decryptStorageState("x".repeat(MAX_ENCRYPTED_ENVELOPE_CHARACTERS + 1), key),
    ).rejects.toThrow("Unable to decrypt storage state");
    await expect(decryptStorageState(JSON.stringify({
      version: 1,
      iv: Buffer.alloc(12).toString("base64"),
      ciphertext: "A".repeat(MAX_CIPHERTEXT_BASE64_CHARACTERS + 1),
    }), key)).rejects.toThrow("Unable to decrypt storage state");
  });
});
