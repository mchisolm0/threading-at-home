import { createHash, randomBytes } from "node:crypto";

const sha256Prefix = "sha256:";

export function hashToken(token: string): string {
  const trimmed = token.trim();

  if (trimmed.length === 0) {
    throw new Error("Token must not be empty");
  }

  return `${sha256Prefix}${createHash("sha256").update(trimmed, "utf8").digest("hex")}`;
}

export function createLocalRunnerAuthHash(): string {
  return hashToken(randomBytes(32).toString("base64url"));
}

export function isTokenHash(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}
