# GitHub App Configuration

OSS Capacity uses two separate GitHub integrations:

- GitHub OAuth identifies the signed-in maintainer.
- A GitHub App installation verifies repository access and lets the broker check whether the maintainer can register the repository.

Do not store volunteer Codex credentials in GitHub, Convex, or the web app. The GitHub App only verifies maintainer repository access.

## GitHub OAuth

Configure OAuth as described in the root README. The callback URL is:

```text
https://<deployment>.convex.site/api/auth/callback/github
```

## GitHub App Settings

Create a GitHub App owned by the account that should operate OSS Capacity.

Use these URLs:

```text
Homepage URL: https://<web-app-host>
Callback URL: https://<web-app-host>/dashboard
Webhook URL: https://<deployment>.convex.site/github/webhook
Setup URL: https://<web-app-host>/dashboard
```

Subscribe to these webhook events:

- Installation
- Installation repositories

Set repository permissions to:

- Metadata: read-only

The registration flow uses the installation access token to call GitHub's repository metadata endpoint and repository collaborator permission endpoint. It accepts repository owners, `admin`, and `maintain` permissions.

Useful GitHub references:

- [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)
- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [REST API endpoints for repositories](https://docs.github.com/rest/repos/repos)
- [REST API endpoints for GitHub Apps](https://docs.github.com/en/rest/apps/apps)

## Convex Environment

Set these values in the Convex deployment. Never commit the private key or webhook secret.

```sh
npx convex env set GITHUB_APP_ID <numeric-github-app-id>
npx convex env set GITHUB_APP_PRIVATE_KEY "$(cat path/to/private-key.pem)"
npx convex env set GITHUB_APP_WEBHOOK_SECRET <random-webhook-secret>
```

If your shell or deployment workflow cannot preserve newlines, store the private key with escaped `\n` characters. The runtime accepts either form.

Keep the existing OAuth values too:

```sh
npx convex env set SITE_URL https://<web-app-host>
npx convex env set AUTH_GITHUB_ID <github-oauth-client-id>
npx convex env set AUTH_GITHUB_SECRET <github-oauth-client-secret>
```

## Web App Environment

Expose the Convex deployment and, optionally, the public GitHub App installation URL:

```sh
NEXT_PUBLIC_CONVEX_URL=https://<deployment>.convex.cloud
NEXT_PUBLIC_GITHUB_APP_INSTALL_URL=https://github.com/apps/<app-slug>/installations/new
```

## Registration Flow

1. A maintainer signs in with GitHub OAuth.
2. The maintainer installs the GitHub App on a repository.
3. GitHub sends an `installation` or `installation_repositories` webhook to Convex.
4. Convex verifies the webhook HMAC signature and syncs the installation record.
5. The dashboard lists synced installed repositories.
6. The maintainer registers `owner/repo`.
7. Convex creates a GitHub App installation access token and checks the maintainer's GitHub repository permission.
8. If the user is the repository owner or has `admin`/`maintain`, Convex creates or refreshes the project as `verified`.

## Local Validation

The repository includes mocked tests for webhook signature verification, installation payload parsing, repository permission decisions, and repository full-name validation.

Live GitHub verification requires real OAuth credentials, a GitHub App private key, an installation, and webhook delivery. Without those secrets, run the local checks and use the dashboard only after manually configuring the Convex environment above.
