# OSS Capacity

OSS Capacity lets open source maintainers request Codex-powered work while volunteers run Codex locally on their own machines. Convex brokers task state and results; volunteer Codex credentials stay on the volunteer machine.

## Repository Layout

- `apps/web`: Next.js app shell for maintainer and volunteer workflows.
- `apps/runner`: Local volunteer runner CLI shell.
- `convex`: Convex broker functions placeholder.
- `packages/core`: Shared TypeScript contracts and policy helpers.
- `packages/codex`: Local Codex integration package placeholder.
- `packages/github`: GitHub integration package placeholder.

## Setup

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

## GitHub OAuth

The web app uses Convex Auth with GitHub OAuth. Configure these values in the
Convex deployment, never in committed files:

```sh
npx convex env set SITE_URL http://localhost:3000
npx convex env set AUTH_GITHUB_ID <github-oauth-client-id>
npx convex env set AUTH_GITHUB_SECRET <github-oauth-client-secret>
```

Convex Auth also requires `JWT_PRIVATE_KEY` and `JWKS` in the Convex deployment.
Generate them with `npx @convex-dev/auth` or the Convex Auth manual setup guide.
Set the GitHub OAuth callback URL to:

```text
https://<deployment>.convex.site/api/auth/callback/github
```

For the Next.js app, set:

```sh
NEXT_PUBLIC_CONVEX_URL=https://<deployment>.convex.cloud
```

Run the web app during development:

```sh
pnpm dev
```

Run the runner placeholder:

```sh
pnpm --filter @oss-capacity/runner dev
```

## GitHub App Installation Verification

Project registration requires a GitHub App installation in addition to GitHub
OAuth sign-in. Configure the app id, private key, webhook secret, webhook URL,
installation URL, and required permissions using
[docs/github-app-configuration.md](docs/github-app-configuration.md).
