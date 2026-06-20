export const githubPackageLabel = "oss-capacity:github";

export type GitHubRepositoryPermission =
  | "admin"
  | "maintain"
  | "write"
  | "read"
  | "push"
  | "triage"
  | "pull"
  | "none";

export type GitHubInstallationSync = {
  readonly event: "installation" | "installation_repositories";
  readonly action: string;
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountType: string;
  readonly repositoryFullNames: readonly string[];
  readonly addedRepositoryFullNames: readonly string[];
  readonly removedRepositoryFullNames: readonly string[];
  readonly status: "active" | "suspended" | "deleted";
  readonly senderGithubUserId?: string;
};

type GitHubRepositoryPayload = {
  readonly full_name?: unknown;
};

type GitHubWebhookPayload = {
  readonly action?: unknown;
  readonly installation?: {
    readonly id?: unknown;
    readonly account?: {
      readonly login?: unknown;
      readonly type?: unknown;
    };
  };
  readonly repositories?: readonly GitHubRepositoryPayload[];
  readonly repositories_added?: readonly GitHubRepositoryPayload[];
  readonly repositories_removed?: readonly GitHubRepositoryPayload[];
  readonly sender?: {
    readonly id?: unknown;
  };
};

type GitHubPermissionPayload = {
  readonly permission?: unknown;
  readonly role_name?: unknown;
  readonly user?: {
    readonly login?: unknown;
  };
};

type GitHubCreatedIssueCommentPayload = {
  readonly id?: unknown;
  readonly html_url?: unknown;
};

type GitHubCreatedIssuePayload = {
  readonly id?: unknown;
  readonly number?: unknown;
  readonly html_url?: unknown;
};

const repositoryFullNamePattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const textEncoder = new TextEncoder();

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumberOrString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }

  return asString(value);
}

function uniqueRepositoryFullNames(
  repositories: readonly GitHubRepositoryPayload[] | undefined
): string[] {
  const normalized = new Map<string, string>();

  for (const repository of repositories ?? []) {
    const fullName = asString(repository.full_name);

    if (fullName !== undefined) {
      const normalizedFullName = normalizeRepositoryFullName(fullName);
      const key = normalizedFullName.toLowerCase();

      if (!normalized.has(key)) {
        normalized.set(key, normalizedFullName);
      }
    }
  }

  return [...normalized.values()].sort((left, right) => left.localeCompare(right));
}

function base64Url(bytes: Uint8Array | string): string {
  const binary =
    typeof bytes === "string"
      ? bytes
      : String.fromCharCode(...Array.from(bytes));

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

function derLength(length: number): number[] {
  if (length < 128) {
    return [length];
  }

  const bytes: number[] = [];
  let remaining = length;

  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }

  return [0x80 | bytes.length, ...bytes];
}

function derWrap(tag: number, bytes: Uint8Array): Uint8Array {
  return Uint8Array.from([tag, ...derLength(bytes.length), ...bytes]);
}

function derSequence(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(1 + derLength(length).length + length);
  let offset = 0;

  output.set([0x30, ...derLength(length)], offset);
  offset += 1 + derLength(length).length;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

function pkcs1ToPkcs8(pkcs1Bytes: Uint8Array): Uint8Array {
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const rsaEncryptionAlgorithm = Uint8Array.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00
  ]);
  const privateKey = derWrap(0x04, pkcs1Bytes);

  return derSequence([version, rsaEncryptionAlgorithm, privateKey]);
}

function privateKeyBytes(privateKeyPem: string): Uint8Array {
  const normalizedPem = privateKeyPem.replaceAll("\\n", "\n");
  const isPkcs1 = normalizedPem.includes("BEGIN RSA PRIVATE KEY");
  const isPkcs8 = normalizedPem.includes("BEGIN PRIVATE KEY");
  const base64 = normalizedPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");

  if ((!isPkcs1 && !isPkcs8) || base64.length === 0) {
    throw new Error("GitHub App private key must be a PEM private key");
  }

  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

  return isPkcs1 ? pkcs1ToPkcs8(bytes) : bytes;
}

export function normalizeRepositoryFullName(fullName: string): string {
  const normalized = fullName.trim();

  if (!repositoryFullNamePattern.test(normalized)) {
    throw new Error("Expected a GitHub repository full name like owner/repo");
  }

  return normalized;
}

export function repositoryOwnerAndName(fullName: string): {
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
} {
  const normalized = normalizeRepositoryFullName(fullName);
  const [owner, name] = normalized.split("/");

  return { owner, name, fullName: normalized };
}

export function buildGitHubIssueCommentRequest(input: {
  readonly repositoryFullName: string;
  readonly issueNumber: number;
  readonly body: string;
}): {
  readonly method: "POST";
  readonly url: string;
  readonly body: string;
} {
  if (!Number.isInteger(input.issueNumber) || input.issueNumber < 1) {
    throw new Error("GitHub issue comment request requires a positive issue number");
  }

  const repository = repositoryOwnerAndName(input.repositoryFullName);

  return {
    method: "POST",
    url: `https://api.github.com/repos/${repository.owner}/${repository.name}/issues/${input.issueNumber}/comments`,
    body: JSON.stringify({ body: input.body })
  };
}

export function buildGitHubIssueRequest(input: {
  readonly repositoryFullName: string;
  readonly title: string;
  readonly body: string;
}): {
  readonly method: "POST";
  readonly url: string;
  readonly body: string;
} {
  const title = input.title.trim();

  if (title.length === 0) {
    throw new Error("GitHub issue request requires a title");
  }

  const repository = repositoryOwnerAndName(input.repositoryFullName);

  return {
    method: "POST",
    url: `https://api.github.com/repos/${repository.owner}/${repository.name}/issues`,
    body: JSON.stringify({ title, body: input.body })
  };
}

export function parseGitHubCreatedIssueComment(
  payload: GitHubCreatedIssueCommentPayload
): {
  readonly githubId: string;
  readonly url: string;
} {
  const githubId = asNumberOrString(payload.id);
  const url = asString(payload.html_url);

  if (githubId === undefined || url === undefined) {
    throw new Error("GitHub issue comment response did not include id and html_url");
  }

  return { githubId, url };
}

export function parseGitHubCreatedIssue(
  payload: GitHubCreatedIssuePayload
): {
  readonly githubId: string;
  readonly number: number;
  readonly url: string;
} {
  const githubId = asNumberOrString(payload.id);
  const url = asString(payload.html_url);
  const number =
    typeof payload.number === "number" && Number.isSafeInteger(payload.number)
      ? payload.number
      : undefined;

  if (githubId === undefined || number === undefined || url === undefined) {
    throw new Error("GitHub issue response did not include id, number, and html_url");
  }

  return { githubId, number, url };
}

export function parseGitHubRepositoryPermission(
  payload: GitHubPermissionPayload
): {
  readonly permission: GitHubRepositoryPermission;
  readonly roleName?: string;
  readonly userLogin?: string;
} {
  const permission = asString(payload.permission) ?? "none";

  if (
    permission !== "admin" &&
    permission !== "maintain" &&
    permission !== "write" &&
    permission !== "read" &&
    permission !== "push" &&
    permission !== "triage" &&
    permission !== "pull" &&
    permission !== "none"
  ) {
    throw new Error(`Unexpected GitHub repository permission: ${permission}`);
  }

  return {
    permission,
    roleName: asString(payload.role_name),
    userLogin: asString(payload.user?.login)
  };
}

export function hasRepositoryMaintainerPermission(input: {
  readonly viewerLogin: string;
  readonly repositoryOwnerLogin: string;
  readonly permission: GitHubRepositoryPermission;
  readonly roleName?: string;
}): boolean {
  if (
    input.viewerLogin.toLowerCase() === input.repositoryOwnerLogin.toLowerCase()
  ) {
    return true;
  }

  return (
    input.permission === "admin" ||
    input.permission === "maintain" ||
    input.roleName === "admin" ||
    input.roleName === "maintain"
  );
}

export async function signGitHubWebhookPayload(
  secret: string,
  body: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(body)
  );

  return `sha256=${hex(signature)}`;
}

export async function verifyGitHubWebhookSignature(input: {
  readonly secret: string;
  readonly body: string;
  readonly signature: string | null;
}): Promise<boolean> {
  if (input.signature === null || !input.signature.startsWith("sha256=")) {
    return false;
  }

  const expected = await signGitHubWebhookPayload(input.secret, input.body);

  return constantTimeEqual(expected, input.signature);
}

export function parseGitHubInstallationWebhook(input: {
  readonly event: string;
  readonly payload: unknown;
}): GitHubInstallationSync | null {
  if (
    input.event !== "installation" &&
    input.event !== "installation_repositories"
  ) {
    return null;
  }

  if (typeof input.payload !== "object" || input.payload === null) {
    throw new Error("Expected a GitHub webhook JSON object");
  }

  const payload = input.payload as GitHubWebhookPayload;
  const action = asString(payload.action);
  const installationId = asNumberOrString(payload.installation?.id);
  const accountLogin = asString(payload.installation?.account?.login);
  const accountType = asString(payload.installation?.account?.type);

  if (
    action === undefined ||
    installationId === undefined ||
    accountLogin === undefined ||
    accountType === undefined
  ) {
    throw new Error("GitHub installation webhook is missing required fields");
  }

  const repositoryFullNames = uniqueRepositoryFullNames(payload.repositories);
  const addedRepositoryFullNames = uniqueRepositoryFullNames(
    payload.repositories_added
  );
  const removedRepositoryFullNames = uniqueRepositoryFullNames(
    payload.repositories_removed
  );
  const status =
    action === "deleted"
      ? "deleted"
      : action === "suspend"
        ? "suspended"
        : "active";

  return {
    event: input.event,
    action,
    installationId,
    accountLogin,
    accountType,
    repositoryFullNames,
    addedRepositoryFullNames,
    removedRepositoryFullNames,
    status,
    senderGithubUserId: asNumberOrString(payload.sender?.id)
  };
}

export async function createGitHubAppJwt(input: {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly nowSeconds?: number;
}): Promise<string> {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: input.appId
    })
  );
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes(input.privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    textEncoder.encode(signingInput)
  );

  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}
