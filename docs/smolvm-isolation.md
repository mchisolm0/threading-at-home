# smolvm Runner Isolation

smolvm support is an optional runner-side hardening layer for explicit task
commands and tests. It does not replace local Codex execution. Codex still runs
on the volunteer machine, Convex brokers task and result state, and volunteer
Codex credentials stay on the volunteer machine.

## Setup

Install smolvm on the volunteer machine and confirm the runner can discover it:

```sh
curl -sSL https://smolmachines.com/install.sh | bash
smolvm --help
pnpm --filter @oss-capacity/runner dev -- diagnose
```

The `diagnose` command reports a `smolvm` check with:

- `available: true` when the CLI responds to `smolvm --help`.
- `available: false` with `status: missing` or `status: unavailable` when the
  CLI is not installed or cannot run.

The availability check does not read Codex auth, runner auth hashes, setup
tokens, SSH keys, or project credentials.

## Task Shape

smolvm execution is opt-in. A task must include an explicit `execution` block
and require the matching runner capabilities:

```json
{
  "execution": {
    "isolation": "smolvm",
    "image": "node:22-alpine",
    "network": false,
    "commands": [
      {
        "name": "unit tests",
        "argv": ["pnpm", "test"],
        "timeoutMs": 120000
      }
    ],
    "artifacts": [
      {
        "path": "reports/test.log",
        "kind": "log",
        "maxBytes": 50000,
        "mediaType": "text/plain"
      }
    ],
    "maxOutputBytes": 131072
  },
  "requiredCapabilities": [
    "codex.exec.json",
    "sandbox.read_only",
    "network.disabled",
    "smolvm.available",
    "smolvm.workspace_snapshot",
    "smolvm.command_bridge",
    "artifact.extract"
  ]
}
```

Only `patch_proposal` and `test_investigation` tasks may request isolated
command execution. Commands are argv arrays, not maintainer-provided shell
scripts. The runner uses a small fixed shell wrapper only to enter `/workspace`
inside the VM before executing the argv list.

## Workspace Strategy

The runner first prepares the normal clean checkout for Codex. When a task has a
smolvm execution block, the runner then stages a separate VM workspace snapshot.
The VM sees that staged directory mounted at `/workspace`; it does not see the
live checkout or the volunteer home directory.

The snapshot skips known local or generated state, including:

- `.git`
- `.codex`
- `.ssh`
- `.env*`
- `.npmrc`
- `node_modules`
- `dist`
- `coverage`
- symlinks

The snapshot is bounded by file count and byte limits. When limits or excluded
paths are encountered, the runner records sanitized warnings in the result.

## Execution And Artifacts

For each explicit command, the runner constructs:

```sh
smolvm machine run --image <image> -v <snapshot>:/workspace -- /bin/sh -c 'cd /workspace && exec "$@"' oss-capacity-command <argv...>
```

Network is off unless the task execution block enables it. If network is
enabled, `allowHosts` is passed through as smolvm host allowlist entries.

Each command has a timeout and output byte limit. Stdout, stderr, command
summaries, warnings, errors, and extracted artifact contents are redacted before
they are recorded. Artifact extraction is limited to declared relative file
paths, per-file byte caps, and result-package metadata. The runner does not
upload whole worktrees, VM images, huge logs, or local secret material.

## Fallback Behavior

Existing read-only and patch proposal tasks do not require smolvm and continue
to use the local runner path when smolvm is unavailable.

If a task includes smolvm execution, there is no silent fallback to host command
execution. The runner fails the run with a sanitized diagnostic such as
`smolvm isolation required but missing`.

## Limitations

This is a bounded hardening layer, not full virtualization product hardening.

- Codex itself still runs on the host because copying ChatGPT/Codex auth into a
  guest would break the trust boundary.
- Codex shell actions are not transparently remoted into smolvm; only the
  task's explicit approved command/test list runs in the VM.
- smolvm must be installed and usable on the volunteer host.
- smolvm platform limits still apply, including Hypervisor.framework/KVM
  support, same-architecture guest artifacts, TCP/UDP-only networking, and
  directory volume mounts.
- Artifact extraction assumes text-like logs/results so redaction can be
  applied before local storage and result metadata generation.
