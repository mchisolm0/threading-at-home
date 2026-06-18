import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  createGitHubAppJwt,
  hasRepositoryMaintainerPermission,
  normalizeRepositoryFullName,
  parseGitHubInstallationWebhook,
  parseGitHubRepositoryPermission,
  signGitHubWebhookPayload,
  verifyGitHubWebhookSignature
} from "../src/index.js";

describe("GitHub App helpers", () => {
  it("normalizes repository full names", () => {
    expect(normalizeRepositoryFullName(" openai/codex ")).toBe("openai/codex");
    expect(() => normalizeRepositoryFullName("openai")).toThrow(
      "Expected a GitHub repository full name"
    );
  });

  it("verifies GitHub webhook signatures", async () => {
    const body = JSON.stringify({ action: "created" });
    const signature = await signGitHubWebhookPayload("secret", body);

    await expect(
      verifyGitHubWebhookSignature({ secret: "secret", body, signature })
    ).resolves.toBe(true);
    await expect(
      verifyGitHubWebhookSignature({
        secret: "different",
        body,
        signature
      })
    ).resolves.toBe(false);
    await expect(
      verifyGitHubWebhookSignature({
        secret: "secret",
        body,
        signature: null
      })
    ).resolves.toBe(false);
  });

  it("parses installation webhooks", () => {
    expect(
      parseGitHubInstallationWebhook({
        event: "installation",
        payload: {
          action: "created",
          installation: {
            id: 123,
            account: {
              login: "openai",
              type: "Organization"
            }
          },
          repositories: [
            { full_name: "openai/codex" },
            { full_name: "OpenAI/Codex" },
            { full_name: "openai/evals" }
          ],
          sender: {
            id: 456
          }
        }
      })
    ).toEqual({
      event: "installation",
      action: "created",
      installationId: "123",
      accountLogin: "openai",
      accountType: "Organization",
      repositoryFullNames: ["openai/codex", "openai/evals"],
      addedRepositoryFullNames: [],
      removedRepositoryFullNames: [],
      status: "active",
      senderGithubUserId: "456"
    });
  });

  it("parses installation repository delta webhooks", () => {
    expect(
      parseGitHubInstallationWebhook({
        event: "installation_repositories",
        payload: {
          action: "removed",
          installation: {
            id: "123",
            account: {
              login: "openai",
              type: "Organization"
            }
          },
          repositories_added: [{ full_name: "openai/evals" }],
          repositories_removed: [{ full_name: "openai/codex" }]
        }
      })
    ).toEqual({
      event: "installation_repositories",
      action: "removed",
      installationId: "123",
      accountLogin: "openai",
      accountType: "Organization",
      repositoryFullNames: [],
      addedRepositoryFullNames: ["openai/evals"],
      removedRepositoryFullNames: ["openai/codex"],
      status: "active",
      senderGithubUserId: undefined
    });
  });

  it("accepts owner, admin, and maintain repository permissions", () => {
    expect(
      hasRepositoryMaintainerPermission({
        viewerLogin: "octocat",
        repositoryOwnerLogin: "octocat",
        permission: "pull"
      })
    ).toBe(true);
    expect(
      hasRepositoryMaintainerPermission({
        viewerLogin: "octocat",
        repositoryOwnerLogin: "openai",
        permission: "admin"
      })
    ).toBe(true);
    expect(
      hasRepositoryMaintainerPermission({
        viewerLogin: "octocat",
        repositoryOwnerLogin: "openai",
        permission: "maintain"
      })
    ).toBe(true);
    expect(
      hasRepositoryMaintainerPermission({
        viewerLogin: "octocat",
        repositoryOwnerLogin: "openai",
        permission: "write",
        roleName: "maintain"
      })
    ).toBe(true);
    expect(
      hasRepositoryMaintainerPermission({
        viewerLogin: "octocat",
        repositoryOwnerLogin: "openai",
        permission: "write"
      })
    ).toBe(false);
  });

  it("parses GitHub repository permission API responses", () => {
    expect(
      parseGitHubRepositoryPermission({
        permission: "maintain",
        role_name: "maintain",
        user: { login: "octocat" }
      })
    ).toEqual({
      permission: "maintain",
      roleName: "maintain",
      userLogin: "octocat"
    });
    expect(
      parseGitHubRepositoryPermission({
        permission: "write",
        role_name: "maintain"
      })
    ).toEqual({
      permission: "write",
      roleName: "maintain",
      userLogin: undefined
    });
  });

  it("creates GitHub App JWTs from RSA private keys", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048
    });
    const privateKeyPem = privateKey.export({
      format: "pem",
      type: "pkcs1"
    }) as string;
    const jwt = await createGitHubAppJwt({
      appId: "12345",
      privateKeyPem,
      nowSeconds: 1_800_000_000
    });

    expect(jwt.split(".")).toHaveLength(3);
  });
});
