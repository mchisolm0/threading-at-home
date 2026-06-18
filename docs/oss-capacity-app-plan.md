# OSS Capacity App Plan

## Core Answer

Yes: the product can be structured so OSS maintainers create prompts inside the app, associate them with their project, and volunteers let their local app pick up eligible prompts and run Codex locally.

That is probably the best first product shape because:

- maintainers get a good UX for creating and managing work
- volunteers keep control of their account, machine, and capacity policy
- the app can verify that a prompt belongs to a real project maintainer
- the system avoids sharing Codex credentials or letting maintainers directly use a volunteer account
- task results can go to a maintainer inbox instead of spamming GitHub

The key framing:

> Maintainers request work. Volunteers opt into projects. Volunteer machines run approved task requests locally when the volunteer has Codex capacity to spare.

## Product Shape

Working name in this doc: **OSS Capacity**.

There are three product surfaces:

1. Maintainer web app
2. Volunteer local runner
3. Shared broker/results service

## Recommended Tech Stack

Use a TypeScript-first stack with Convex as the broker/database.

Recommended repo shape:

```text
apps/web          Next.js app for maintainers, volunteers, inbox, settings
apps/runner       Local volunteer CLI/daemon that talks to Convex and runs Codex
apps/desktop      Later Tauri shell around the runner, if needed
convex/           Convex schema, queries, mutations, actions, HTTP actions, crons
packages/core     Shared task schemas, policy logic, result types
packages/codex    Local Codex exec/app-server wrappers used by the runner
packages/github   GitHub App helpers and shared GitHub types
```

Default choices:

- UI: Next.js + React + Tailwind or shadcn/ui
- Backend/database: Convex
- Auth: GitHub OAuth for users, plus a GitHub App for project installation/verification
- Runner: Node.js/TypeScript CLI first
- Codex execution: local `codex exec --json --ephemeral --output-schema`
- Codex capacity checks: local `codex app-server` + `account/rateLimits/read`
- Desktop later: Tauri sidecar wrapper around the runner
- Isolation later: smolvm for higher-risk command/test execution

Convex is a good fit because:

- live maintainer inboxes and volunteer dashboards are native to the data model
- task leasing can be a transactional mutation
- task/result updates automatically stream to the UI
- GitHub webhooks and runner-facing endpoints can be HTTP actions
- lease expiration, stale-run cleanup, and digest jobs can be scheduled functions/crons
- most backend code stays in TypeScript
- the first version does not need a separate API server, queue, Redis, or worker service

Convex should own:

- users and GitHub identities
- projects and GitHub App installations
- task requests
- task leases
- volunteer project subscriptions
- volunteer runner registrations
- run metadata
- result inbox state
- audit events

Convex should not run Codex. The volunteer runner runs Codex locally. This keeps volunteer Codex credentials on the volunteer machine and keeps long-running agent work out of the hosted backend.

Store large run artifacts carefully. Small structured results can live in Convex documents, but long logs, patches, transcripts, and attachments should go into Convex file storage or object storage with metadata pointers in Convex.

Use Convex actions for side-effecting cloud work:

- verify GitHub installation data
- call GitHub APIs through Octokit
- send emails/notifications
- process webhook payloads
- enqueue cleanup/digest work

Use Convex mutations for state transitions that must be atomic:

- create task request
- validate/activate task request
- lease task to runner
- heartbeat lease
- complete run
- fail run
- release expired lease
- archive/promote result

Key caveats:

- Keep runner secrets separate from GitHub App secrets and never store Codex credentials in Convex.
- Treat runner API tokens as revocable device tokens scoped to one volunteer runner.
- Do not put huge logs directly in documents.
- Keep a small `packages/core` schema layer so we can move away from Convex later if we ever need to.
- Use GitHub App installation verification separately from GitHub OAuth; OAuth proves the user, the App installation proves repo access.

### Maintainer Web App

Maintainers sign in with GitHub and install a GitHub App on one or more repositories. The app verifies that the user has sufficient permission on the repo before letting them create task requests.

Maintainers can:

- register a project, e.g. `owner/repo`
- create task prompts associated with that project
- choose a task type: analysis, triage, patch proposal, test investigation, docs draft
- set task priority and expiration
- define a target branch or commit SHA
- attach an output schema
- define whether results are private to maintainers or may become public
- review submitted results
- rerun, archive, or promote results into GitHub issues/PRs/comments

### Volunteer Local Runner

Volunteers install a local app or CLI. It authenticates to the shared broker, but Codex runs locally using the volunteer's existing Codex login.

Volunteers can:

- choose projects or maintainers they want to support
- choose task categories they are willing to run
- set a Codex capacity reserve
- set reset-window rules
- set daily/weekly run caps
- choose max permissions: read-only, patch proposal, tests allowed, network allowed
- preview queued task requests before enabling automation
- pause immediately with a kill switch
- review generated outputs before they are uploaded, at least for the early version

### Shared Broker/Results Service

The broker is not a Codex proxy. It should never receive or store volunteer Codex credentials.

It does:

- verify GitHub project ownership/maintainer permission
- store project records
- store maintainer-authored task requests
- match volunteers to eligible task requests
- lease tasks to one runner at a time
- collect structured run results
- route results to the maintainer inbox
- rate-limit projects, maintainers, volunteers, and task categories
- maintain audit logs

It does not:

- run Codex centrally in the MVP
- hold volunteer ChatGPT/Codex tokens
- let maintainers directly operate a volunteer account
- post to public GitHub surfaces without an explicit maintainer action

## Task Lifecycle

1. Maintainer creates a project in the app.
2. GitHub App verifies the maintainer has write/admin permission on the repo.
3. Maintainer creates a task request:
   - prompt
   - task type
   - target repo/ref
   - permissions needed
   - expected size
   - output schema
   - reporting preference
4. Broker validates and lints the task.
5. Task becomes available to volunteers who opted into that project and task type.
6. Volunteer runner periodically checks local Codex capacity through `codex app-server`.
7. If volunteer policy allows, runner asks broker for an eligible task.
8. Broker grants a time-limited lease.
9. Runner clones or updates the repo into a clean workspace.
10. Runner executes Codex locally with the task prompt.
11. Runner captures output, metadata, logs, and optional patch.
12. Runner uploads a result package to the broker.
13. Maintainer reviews the result in the inbox.
14. Maintainer can archive, rerun, comment, create an issue, or open a PR.

## Prompt Object

A maintainer-created prompt should be more structured than a text box.

```yaml
id: weekly-issue-triage
project: owner/repo
title: Triage stale issues
type: analysis
target:
  ref: main
  issue_query: "is:open label:needs-triage"
permissions:
  sandbox: read-only
  network: false
expected_size: small
expires_at: "2026-07-01T00:00:00Z"
prompt: |
  Review open issues labeled needs-triage.
  Group them by likely subsystem, identify duplicates,
  and suggest next maintainer actions. Do not edit files.
output_schema:
  type: object
  required: [summary, groups, risks]
  properties:
    summary:
      type: string
    groups:
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
reporting:
  destination: maintainer_inbox
  public_posting: maintainer_only
```

The app UI can make this friendlier, but the internal object should stay structured.

## App-First vs Repo-First Prompts

There are two possible models.

### App-First

Maintainers create prompts in the app. The app verifies GitHub permissions and stores the task.

Pros:

- easiest maintainer UX
- fastest MVP
- prompts can be edited without repo commits
- better for private maintainer-only task queues
- app can enforce required fields and safety checks

Cons:

- less transparent to contributors
- harder to audit from the repo alone
- requires trust in the broker database

### Repo-First

Maintainers commit task manifests into the repo, e.g. `.oss-capacity/tasks/*.yaml`.

Pros:

- highly auditable
- reviewed like code
- easy to fork/version
- clear project ownership

Cons:

- more friction
- bad UX for quick task iteration
- every prompt change is a repo change
- less natural for maintainer-only experiments

### Recommended Hybrid

Start app-first, with GitHub App verification. Add repo-backed manifests later for projects that want public, reviewable task definitions.

The broker can also export a signed task snapshot so every run records exactly what prompt was executed.

## Volunteer Capacity Policy

The runner should turn quota data into a local policy decision.

Example volunteer settings:

```yaml
projects:
  allow:
    - owner/repo
capacity:
  max_used_percent: 55
  only_if_resets_within_minutes: 180
  max_runs_per_day: 3
  max_estimated_size: small
permissions:
  max_sandbox: read-only
  allow_network: false
  allow_patches: false
review:
  require_before_upload: true
```

The runner checks:

- `codex app-server` account/rate-limit state
- volunteer settings
- task permissions
- daily cap
- current machine state
- broker lease availability

## Execution Strategy

MVP:

- use `codex app-server` for quota/rate-limit reads
- use `codex exec --json --ephemeral --output-schema` for task execution
- run in a clean git worktree
- start with read-only tasks
- upload structured output only
- require maintainer review before any public GitHub action

Later:

- use Codex SDK or app-server for richer live progress, approvals, thread resume, and result inspection
- support patch proposals
- add smolvm for stronger isolation around command/test execution
- support task reruns and consensus from multiple volunteers

## Trust Boundaries

Maintainer prompts are trusted only by volunteers who chose the project. They are still untrusted input from the runner's perspective.

Rules:

- no volunteer Codex credentials leave the machine
- no maintainer-supplied secret access
- no repo task can request the volunteer's local files
- no network by default
- no public posting by default
- no unattended write actions in MVP
- no copying `~/.codex/auth.json` into VMs or containers

## Result Package

Each run should upload:

- run id
- task id
- project id
- prompt hash
- target repo/ref/SHA
- Codex CLI version
- sandbox mode
- start/end timestamp
- final structured output
- usage summary when available
- command/test summary if commands ran
- patch/diff if patch proposals are enabled
- warnings/errors

Volunteer identity should be configurable:

- anonymous to maintainer
- display name only
- GitHub identity

Default should be private or pseudonymous until the volunteer opts in.

## MVP Scope

Build the smallest useful version:

1. GitHub sign-in and project registration for maintainers.
2. Maintainer task creation in the app.
3. Project/task allowlist for volunteers.
4. Local runner policy file.
5. Codex rate-limit probe.
6. Read-only Codex execution with structured output.
7. Broker task lease.
8. Maintainer inbox.
9. Manual result promotion only.

Implementation sequencing lives in `docs/implementation-roadmap.md`. Thread handoff and review/PR workflow lives in `docs/threaded-delivery-workflow.md`.

Explicitly exclude from MVP:

- auto-opening PRs
- maintainer-supplied shell scripts
- networked tasks
- volunteer account sharing
- task marketplace/payment
- central Codex execution
- smolvm as a hard dependency

## Key Product Decisions To Make

1. Should the first volunteer runner be a CLI, desktop app, or background menu-bar app?
2. Should volunteers review every result before upload, or only results with patches/logs?
3. Should maintainers see volunteer identities by default?
4. Should tasks be public to all volunteers, or only to volunteers who explicitly opt into the project?
5. Should app-first prompts be mirrored into the repo for auditability?
6. What is the first killer task type: issue triage, CI failure summaries, flaky-test investigation, docs drafts, or patch suggestions?

## Opinionated Recommendation

Start narrow:

- app-first maintainer prompts
- GitHub-verified project ownership
- volunteer project allowlist
- read-only analysis tasks
- local Codex capacity policy
- private maintainer inbox
- manual public promotion

This gives the idea a clean trust model and avoids the most dangerous early failure modes: spam, credential exposure, quota resale framing, and unreviewed AI writes.
