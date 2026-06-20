# Desktop Runner Wrapper

`apps/desktop` is a local Tauri shell around the existing volunteer runner CLI.
It does not add a broker, execution engine, hosted daemon, or credential export
path. Codex still runs on the volunteer machine, Convex brokers task and result
state, and volunteer Codex credentials stay on the volunteer machine.

## Development

Install workspace dependencies, then run the desktop shell:

```sh
pnpm install
pnpm --filter @oss-capacity/desktop dev
```

The Tauri app starts a Vite frontend and calls the runner through the local
workspace command:

```sh
pnpm --filter @oss-capacity/runner dev -- <runner-command>
```

The shell currently uses these runner commands:

- `diagnose` for status and capacity checks.
- `run-once` inside a local interval loop when the volunteer clicks Start.

The interval loop is intentionally small and local. It waits at least 60 seconds
between `run-once` attempts and Stop requests cancellation of the current local
runner command before ending the loop. This wraps the existing runner behavior;
it does not invent new broker-side semantics.

## Runner Configuration

Use the same setup flow as the CLI:

```sh
pnpm --filter @oss-capacity/runner exec oss-capacity-runner login \
  --broker-url https://<deployment>.convex.cloud \
  --setup-token <one-time-setup-token> \
  --name "Local desktop runner"
```

The desktop shell respects the runner's existing environment overrides,
including:

- `OSS_CAPACITY_RUNNER_CONFIG`
- `OSS_CAPACITY_RUNNER_LOG_DIR`
- `OSS_CAPACITY_RUNNER_STATE_HOME`
- `OSS_CAPACITY_REPO_ROOT`

For packaged experiments where the runner CLI is already on `PATH`, override
the command prefix:

```sh
OSS_CAPACITY_DESKTOP_RUNNER_COMMAND="oss-capacity-runner" \
  pnpm --filter @oss-capacity/desktop dev
```

## Logs and Redaction

The logs view reads recent `.json` files from the runner's local log directory.
It shows a bounded newest-first list, truncates large files, and redacts common
secret-shaped values, emails, hashes, and local paths before display. The runner
already writes sanitized logs; the desktop layer redacts again because logs are
local machine data.

The desktop UI does not render setup tokens, runner auth hashes, raw account
identifiers, Codex auth paths, or volunteer-local secret paths.

## Build and Packaging

Workspace CI can build the frontend without platform signing:

```sh
pnpm --filter @oss-capacity/desktop build
```

Native Tauri builds are available for local packaging experiments:

```sh
pnpm --filter @oss-capacity/desktop tauri:build
```

`bundle.active` is disabled in `src-tauri/tauri.conf.json` for now. Platform
signing, notarization, auto-update, sidecar bundling, and installer polish are
not part of Task 7.3.
