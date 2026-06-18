# Codex OSS Capacity Research

Sources checked: 2026-06-18

## Short Take

The idea is technically plausible, but the framing should not be "donate leftover subscription" or "share quota." The safer product shape is:

> A local, user-controlled volunteer runner that spends the volunteer's own available Codex capacity on maintainer-approved open-source tasks when the volunteer has capacity to spare.

The first version should bias toward read-only or low-risk maintainer workflows: issue triage, CI-log summaries, flaky-test clustering, dependency-upgrade planning, docs/release-note drafting, security alert triage, and patch suggestions that a maintainer reviews before merge.

The main feasibility hinge is quota visibility. Codex does not appear to expose a simple `codex quota --json` command, but `codex app-server` documents an `account/rateLimits/read` JSON-RPC method with `usedPercent`, `windowDurationMins`, `resetsAt`, `rateLimitReachedType`, and available earned reset credits. That gives enough signal for an MVP scheduler.

## Recommended Language

Use:

- "Volunteer unused Codex capacity"
- "Contribute idle Codex time to open source"
- "Run maintainer-requested tasks when you have capacity to spare"
- "Reserve at least X% of my Codex capacity for me"
- "Only run volunteer tasks when reset is within N hours"
- "Maintainer-requested task"
- "Volunteer runner"
- "Available capacity window"

Avoid:

- "Donate your subscription"
- "Transfer quota"
- "Pool subscriptions"
- "Sell/rent Codex access"
- "Let maintainers use your account"
- "Marketplace for unused AI"

Reason: OpenAI's consumer Terms say users may not share credentials or make their account available to someone else, and the Business Agreement restricts reselling, leasing, transferring API keys, and circumventing usage limits. This memo is not legal advice, but the product should be designed as the donor running tasks locally under their own account, with clear consent and revocation, not as account delegation.

## Product Shape

There are three actors:

- Maintainer: publishes task manifests for a repository they control.
- Volunteer: opts into projects and defines local limits.
- Broker/indexer: matches eligible tasks to volunteers, stores task metadata, and routes results back to maintainers.

The volunteer app should make these controls explicit:

- Project allowlist: repositories or maintainers the volunteer wants to support.
- Capacity reserve: e.g. "do not run if usage is above 60%" or "always leave 40% unused."
- Reset window: e.g. "only run if the current window resets within 3 hours."
- Daily cap: maximum volunteer turns/tasks per day.
- Permission mode: read-only, workspace-write, or "never unattended."
- Result mode: auto-report safe read-only outputs; require approval before posting patches or PRs.
- Privacy mode: do not send local paths, account email, or host details to maintainers.

Maintainers should publish tasks in-repo so task intent is reviewable and auditable. A possible manifest:

```yaml
version: 1
project: owner/repo
tasks:
  - id: weekly-issue-triage
    title: Triage stale issues
    prompt: |
      Review open issues labeled needs-triage. Group them by likely subsystem,
      identify duplicates, and suggest the next maintainer action. Do not edit files.
    permissions:
      sandbox: read-only
      network: false
    expected_runtime: small
    output_schema:
      type: object
      required: [summary, issue_groups, risks]
      properties:
        summary:
          type: string
        issue_groups:
          type: array
          items:
            type: object
            required: [label, issues, recommendation]
            properties:
              label: { type: string }
              issues:
                type: array
                items: { type: string }
              recommendation: { type: string }
        risks:
          type: array
          items: { type: string }
    report:
      type: maintainer-inbox
      visibility: maintainer-only
```

## Technical Architecture

Recommended MVP path:

1. Local runner starts on the volunteer's machine.
2. Runner reads Codex account/rate-limit state through `codex app-server`.
3. Runner checks volunteer policy: project allowlist, reserve threshold, reset window, daily cap, permission mode.
4. Runner fetches maintainer task manifests from approved repositories.
5. Runner clones or updates the target repo into a clean worktree.
6. Runner executes the selected task with `codex exec --json --ephemeral`, `--sandbox read-only` or `workspace-write`, and `--output-schema` where possible.
7. Runner captures JSONL events, final response, usage data from `turn.completed`, diff/patch if any, Codex version, task manifest hash, repo commit SHA, and start/end timestamps.
8. Runner reports a structured result to a maintainer inbox. Posting to GitHub should be a separate, permissioned step.

For the first implementation, use two Codex surfaces:

- `codex app-server` for `account/rateLimits/read`.
- `codex exec --json` for task execution.

That avoids building a full rich-client protocol adapter on day one. If the app later needs live approvals, thread lists, imports, resumable sessions, or a full GUI, move more execution onto the SDK or app-server.

## Codex Integration Notes

Official docs say:

- Codex CLI can be installed by standalone installer, npm, Homebrew, or releases.
- ChatGPT Plus, Pro, Business, Edu, and Enterprise plans include Codex.
- `codex exec` is the stable non-interactive command for scripts and CI.
- `codex exec --json` emits JSONL events including `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, and `error`.
- `codex exec --output-schema` can force structured final output.
- `codex exec` is read-only by default; automation should use least privilege.
- The Codex SDK is recommended for automation jobs that need more control than `codex exec`.
- `codex app-server` is best for deep product integration: auth, conversation history, approvals, and streamed agent events.
- App-server supports JSON-RPC over stdio by default, with experimental WebSocket and Unix socket modes.
- App-server can generate version-specific TypeScript or JSON schema bundles.

Important quota/account methods:

- `account/read`
- `account/rateLimits/read`
- `account/rateLimits/updated`
- `account/usage/read`
- `account/rateLimitResetCredit/consume`

Local validation:

- `examples/codex-rate-limit-probe.mjs` successfully called `account/read` and `account/rateLimits/read` against the locally installed `codex-cli 0.140.0`.
- The endpoint returned account type, plan metadata, primary and secondary rate-limit windows, reset timestamps, credits metadata, and reset-credit availability.
- The memo intentionally does not record the local account's exact quota values.

The scheduler should define "available capacity" as a local policy decision, not a guarantee. Example:

```text
eligible =
  authMode == "chatgpt"
  and rateLimits.primary.usedPercent <= volunteer.maxUsedPercent
  and rateLimits.primary.resetsAt - now <= volunteer.maxSecondsUntilReset
  and no rateLimitReachedType
  and dailyVolunteerTaskCount < volunteer.dailyCap
```

Then refine with observed task costs from `turn.completed.usage`.

## T3 Code Prior Art

T3 Code is useful prior art because it wraps local coding CLIs, including Codex, behind a GUI.

Observed architecture:

- React/Vite browser app.
- Local Node WebSocket server.
- Provider adapter abstraction.
- Codex provider spawns `codex app-server`.
- Server talks to Codex via JSON-RPC over stdio.
- It maps T3 runtime modes to Codex approval/sandbox settings.
- It tracks threads, turns, checkpoints, and runtime receipts in its own orchestration model.

Lessons:

- A provider abstraction is useful, but start with Codex-only unless multi-provider is a product requirement.
- `CODEX_HOME` and binary path matter. If a user has multiple Codex installs/accounts, the runner must be explicit about which one it is using.
- Version drift is real. T3 issues document failures from both old and new Codex app-server schemas. Add a compatibility check before startup.
- Use `codex app-server generate-json-schema` or `generate-ts` against the installed Codex binary and validate messages at the boundary.
- Persist provider thread IDs/resume cursors if using app-server threads.
- Surface startup/protocol errors clearly. "Codex CLI too old/new for this runner" is much better than generic runtime failure.

## smolvm Fit

smolvm is promising for isolation because it runs workloads in hardware-isolated Linux VMs with container-like ergonomics:

- microVM per workload
- sub-200ms boot target
- macOS Hypervisor.framework or Linux KVM
- OCI images without a Docker daemon
- network off by default
- allowlisted outbound hosts with `--allow-host`
- directory volume mounts
- optional SSH-agent forwarding without copying private keys into the guest
- Node embedded SDK exists, though its README says embedded-created machines are not yet visible via the CLI

Possible patterns:

1. Run Codex outside smolvm, run project commands inside smolvm.
   This keeps ChatGPT/Codex credentials on the host. It is safer for subscription auth, but requires a command-execution adapter so Codex's shell actions happen inside the VM.

2. Run Codex inside smolvm.
   This is simpler isolation-wise, but risky for ChatGPT-managed auth because it tempts copying `~/.codex/auth.json` or access tokens into the guest. This may be acceptable only for API-key automation with a narrowly scoped/ephemeral credential.

3. Use Codex's built-in sandbox first, add smolvm for high-risk task classes later.
   This is the most practical MVP path. Start read-only, gather trust and cost data, then experiment with smolvm for command/test execution.

smolvm limitations to account for:

- host must support Hypervisor.framework or KVM
- macOS binary needs hypervisor entitlements
- network is TCP/UDP only, no ICMP
- volume mounts are directories only
- guest artifact portability is same-architecture
- GPU is possible but adds host dependencies

## Reporting Results

Every result should be reproducible and reviewable:

- task id and manifest hash
- maintainer repo and commit SHA
- volunteer-visible permission mode
- Codex CLI version
- model/service tier if available
- start/end time
- usage summary from JSONL/app-server events
- final structured result
- generated patch, if any
- command/test transcript summary
- warnings about uncertainty

Prefer a maintainer inbox first. Posting directly to GitHub issues/PRs should be optional and rate-limited. The system should avoid creating spammy AI comments across popular projects.

## Security And Abuse Controls

Minimum controls:

- Maintainer verification through GitHub App installation or a signed manifest committed by a repo maintainer.
- Prompt linting: no requests for secrets, credential exfiltration, private data, or external spam.
- Repo allowlist chosen by the volunteer.
- Network disabled by default.
- GitHub write actions disabled by default.
- No maintainer-controlled code should run with donor account credentials in environment variables.
- No copying `~/.codex/auth.json` into guest VMs or public CI.
- Local kill switch.
- Per-project and global rate limits.
- "Show me what would run" dry run mode.

## Open Questions

- Is this allowed under OpenAI terms if framed and implemented as local volunteer execution? Get legal/OpenAI guidance before public launch.
- Should results be posted by the donor identity, a project bot, or only delivered to a maintainer inbox?
- How should maintainers estimate task size? Start with buckets: tiny, small, medium.
- Can Codex app-server rate-limit fields be considered stable enough for a production scheduler, or should the app treat them as best-effort signals?
- How much task context should be fetched from GitHub to avoid burning donor capacity on repo indexing?
- Should volunteers opt into "patch generation" separately from "analysis only"?

## Suggested Next Steps

1. Prototype a local scheduler that calls `account/rateLimits/read`, applies a reserve/reset policy, and runs one read-only task with `codex exec --json --output-schema`.
2. Draft the maintainer task manifest spec and validate it against two real OSS workflows.
3. Build a private maintainer inbox instead of posting GitHub comments directly.
4. Add compatibility checks for `codex --version` and app-server schema generation.
5. Run a smolvm experiment with Codex outside the VM and task commands inside the VM.
6. Ask OpenAI/legal for a read on the framing before using words like "donate" in public copy.

## Sources

- OpenAI Codex CLI docs: https://developers.openai.com/codex/cli
- OpenAI non-interactive mode: https://developers.openai.com/codex/noninteractive
- OpenAI Codex SDK docs: https://developers.openai.com/codex/sdk
- OpenAI Codex app-server docs: https://developers.openai.com/codex/app-server
- Codex app-server README: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Codex pricing/usage limits: https://developers.openai.com/codex/pricing
- Codex for Open Source: https://developers.openai.com/community/codex-for-oss
- OpenAI Terms of Use: https://openai.com/policies/row-terms-of-use/
- OpenAI Services Agreement: https://openai.com/policies/services-agreement/
- T3 Code README: https://github.com/pingdotgg/t3code/blob/main/README.md
- T3 Code architecture docs: https://github.com/pingdotgg/t3code/blob/main/docs/architecture/overview.md
- T3 Code Codex provider docs: https://github.com/pingdotgg/t3code/blob/main/docs/providers/codex.md
- T3 Code Codex adapter: https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Layers/CodexSessionRuntime.ts
- T3 issue about old Codex CLI startup failure: https://github.com/pingdotgg/t3code/issues/360
- T3 issue about app-server schema drift: https://github.com/pingdotgg/t3code/issues/386
- T3 issue about Codex session import/resume parity: https://github.com/pingdotgg/t3code/issues/510
- T3 issue about version compatibility checks: https://github.com/pingdotgg/t3code/issues/2242
- smolvm README: https://github.com/smol-machines/smolvm/blob/main/README.md
- smolvm embedded SDK README: https://github.com/smol-machines/smolvm/blob/main/sdks/README.md
