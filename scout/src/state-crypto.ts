const ENVELOPE_VERSION = 1 as const;
const IV_BYTES = 12;
const AAD = new TextEncoder().encode("threads-patrol-scout-storage-state:v1");
export const MAX_STORAGE_STATE_CHARACTERS = 4 * 1024 * 1024;
const MAX_STORAGE_STATE_BYTES = 4 * 1024 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_STORAGE_STATE_BYTES + 16;
export const MAX_CIPHERTEXT_BASE64_CHARACTERS = Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4;
export const MAX_ENCRYPTED_ENVELOPE_CHARACTERS = MAX_CIPHERTEXT_BASE64_CHARACTERS + 256;

interface CipherEnvelope {
  version: typeof ENVELOPE_VERSION;
  iv: string;
  ciphertext: string;
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid base64");
  }
  const decoded = atob(value);
  return new Uint8Array(Array.from(decoded, (character) => character.charCodeAt(0)));
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeKey(keyBase64: string): Uint8Array<ArrayBuffer> {
  let key: Uint8Array<ArrayBuffer>;
  try {
    key = decodeBase64(keyBase64);
  } catch {
    throw new Error("Storage-state key must be a base64-encoded 32-byte key");
  }
  if (key.byteLength !== 32) {
    throw new Error("Storage-state key must be a base64-encoded 32-byte key");
  }
  return key;
}

function validateStorageStateJson(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid storage state JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Array.isArray(Reflect.get(parsed, "cookies")) ||
    !Array.isArray(Reflect.get(parsed, "origins"))
  ) {
    throw new Error("Invalid storage state shape");
  }
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", decodeKey(keyBase64).buffer, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptStorageState(
  storageStateJson: string,
  keyBase64: string,
): Promise<string> {
  if (storageStateJson.length > MAX_STORAGE_STATE_CHARACTERS) {
    throw new Error("Storage state is too large");
  }
  validateStorageStateJson(storageStateJson);
  const plaintext = new TextEncoder().encode(storageStateJson);
  if (plaintext.byteLength > MAX_STORAGE_STATE_BYTES) {
    throw new Error("Storage state is too large");
  }
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: AAD },
    key,
    plaintext,
  );
  const envelope: CipherEnvelope = {
    version: ENVELOPE_VERSION,
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(envelope);
}

function parseEnvelope(value: string): CipherEnvelope {
  if (value.length > MAX_ENCRYPTED_ENVELOPE_CHARACTERS) {
    throw new Error("Encrypted storage-state envelope is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid encrypted storage-state envelope");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid encrypted storage-state envelope");
  }
  const keys = Object.keys(parsed);
  if (
    keys.length !== 3 ||
    !keys.includes("version") ||
    !keys.includes("iv") ||
    !keys.includes("ciphertext") ||
    Reflect.get(parsed, "version") !== ENVELOPE_VERSION ||
    typeof Reflect.get(parsed, "iv") !== "string" ||
    typeof Reflect.get(parsed, "ciphertext") !== "string"
  ) {
    throw new Error("Invalid encrypted storage-state envelope");
  }
  const envelope = parsed as CipherEnvelope;
  if (
    envelope.iv.length > 32 ||
    envelope.ciphertext.length > MAX_CIPHERTEXT_BASE64_CHARACTERS
  ) {
    throw new Error("Encrypted storage-state envelope is too large");
  }
  return envelope;
}

export async function decryptStorageState(
  encryptedEnvelope: string,
  keyBase64: string,
): Promise<string> {
  const key = await importKey(keyBase64);
  try {
    const envelope = parseEnvelope(encryptedEnvelope);
    const iv = decodeBase64(envelope.iv);
    const ciphertext = decodeBase64(envelope.ciphertext);
    if (
      iv.byteLength !== IV_BYTES ||
      ciphertext.byteLength <= 16 ||
      ciphertext.byteLength > MAX_CIPHERTEXT_BYTES
    ) {
      throw new Error("Invalid ciphertext");
    }
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: AAD },
      key,
      ciphertext.buffer,
    );
    const storageState = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    if (
      storageState.length > MAX_STORAGE_STATE_CHARACTERS ||
      plaintext.byteLength > MAX_STORAGE_STATE_BYTES
    ) {
      throw new Error("Storage state is too large");
    }
    validateStorageStateJson(storageState);
    return storageState;
  } catch {
    throw new Error("Unable to decrypt storage state");
  }
}
