export type RunnerSetupTokenExchangeCandidate = {
  readonly status: string;
  readonly expiresAt?: string;
};

export function normalizeRunnerSetupTokenHash(tokenHash: string): string {
  if (!/^sha256:[a-f0-9]{64}$/i.test(tokenHash)) {
    throw new Error("Runner setup token hash must be a sha256 hex digest");
  }

  return tokenHash.toLowerCase();
}

export function normalizeRunnerAuthTokenHash(tokenHash: string): string {
  if (!/^sha256:[a-f0-9]{64}$/i.test(tokenHash)) {
    throw new Error("Runner auth token hash must be a sha256 hex digest");
  }

  return tokenHash.toLowerCase();
}

export function assertRunnerAuthTokenHashMatches(
  storedTokenHash: string | undefined,
  providedTokenHash: string
): void {
  const normalizedProvided = normalizeRunnerAuthTokenHash(providedTokenHash);

  if (storedTokenHash === undefined) {
    throw new Error("Runner is missing local auth material");
  }

  if (normalizeRunnerAuthTokenHash(storedTokenHash) !== normalizedProvided) {
    throw new Error("Runner auth token does not match");
  }
}

export function assertRunnerSetupTokenCanBeExchanged(
  token: RunnerSetupTokenExchangeCandidate,
  now: string
): void {
  if (token.status !== "active") {
    throw new Error("Runner setup token is not active");
  }

  if (token.expiresAt !== undefined && Date.parse(token.expiresAt) <= Date.parse(now)) {
    throw new Error("Runner setup token has expired");
  }
}
