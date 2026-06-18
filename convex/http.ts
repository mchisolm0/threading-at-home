import { httpRouter } from "convex/server";
import { httpActionGeneric, makeFunctionReference } from "convex/server";
import {
  parseGitHubInstallationWebhook,
  verifyGitHubWebhookSignature,
  type GitHubInstallationSync
} from "@oss-capacity/github";

import { auth } from "./auth.js";

const http = httpRouter();
const syncInstallationFromWebhook = makeFunctionReference<
  "mutation",
  { sync: GitHubInstallationSync },
  GitHubInstallationSync
>("github:syncInstallationFromWebhook");

auth.addHttpRoutes(http);

http.route({
  path: "/github/webhook",
  method: "POST",
  handler: httpActionGeneric(async (ctx, request) => {
    const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;

    if (webhookSecret === undefined || webhookSecret.length === 0) {
      return new Response("GitHub App webhook secret is not configured", {
        status: 500
      });
    }

    const event = request.headers.get("x-github-event") ?? "";
    const signature = request.headers.get("x-hub-signature-256");
    const body = await request.text();
    const signatureIsValid = await verifyGitHubWebhookSignature({
      secret: webhookSecret,
      body,
      signature
    });

    if (!signatureIsValid) {
      return new Response("Invalid GitHub webhook signature", { status: 401 });
    }

    let payload: unknown;

    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      return new Response("Invalid JSON payload", { status: 400 });
    }

    const sync = parseGitHubInstallationWebhook({
      event,
      payload
    });

    if (sync === null) {
      return Response.json({ ignored: true, event });
    }

    const result = await ctx.runMutation(syncInstallationFromWebhook, { sync });

    return Response.json({
      ok: true,
      installationId: result.installationId,
      repositoryCount: result.repositoryFullNames.length,
      status: result.status
    });
  })
});

export default http;
