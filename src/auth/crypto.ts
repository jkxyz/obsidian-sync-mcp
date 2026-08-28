const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

async function secretKey(
  secret: string,
  usage: "hmac" | "aes",
): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  if (usage === "hmac") {
    return crypto.subtle.importKey(
      "raw",
      digest,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function signValue(
  value: string,
  secret: string,
): Promise<string> {
  const key = await secretKey(secret, "hmac");
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );
  return `${value}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifySignedValue(
  signed: string,
  secret: string,
): Promise<string | null> {
  const separator = signed.lastIndexOf(".");
  if (separator <= 0) return null;
  const value = signed.slice(0, separator);
  const signature = signed.slice(separator + 1);
  try {
    const key = await secretKey(secret, "hmac");
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      ownedBuffer(base64UrlToBytes(signature)),
      encoder.encode(value),
    );
    return valid ? value : null;
  } catch {
    return null;
  }
}

export async function encryptJson(
  value: unknown,
  secret: string,
): Promise<string> {
  const key = await secretKey(secret, "aes");
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptJson<T>(
  envelope: string,
  secret: string,
): Promise<T | null> {
  const separator = envelope.indexOf(".");
  if (separator <= 0) return null;
  try {
    const key = await secretKey(secret, "aes");
    const iv = base64UrlToBytes(envelope.slice(0, separator));
    const ciphertext = base64UrlToBytes(envelope.slice(separator + 1));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ownedBuffer(iv) },
      key,
      ownedBuffer(ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
}

export async function createPkce(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = randomToken(48);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) };
}

export async function constantTimeEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(left: ArrayBuffer, right: ArrayBuffer): boolean;
  };
  return subtle.timingSafeEqual(leftHash, rightHash);
}

export function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split("=");
    if (key === name) return valueParts.join("=");
  }
  return null;
}
