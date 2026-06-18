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

Run the web app during development:

```sh
pnpm dev
```

Run the runner placeholder:

```sh
pnpm --filter @oss-capacity/runner dev
```
