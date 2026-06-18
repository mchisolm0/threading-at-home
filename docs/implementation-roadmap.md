# Implementation Roadmap

This roadmap breaks OSS Capacity into small task threads with clear blockers. The goal is to keep each task independently reviewable while preserving the product's trust boundary: maintainers request work, volunteers run Codex locally, and Convex brokers state without receiving volunteer Codex credentials.

## Dependency Map

```text
0. Product contracts and repo scaffold
   |
   +--> 1. Convex data model and task lifecycle
   |       |
   |       +--> 4. Maintainer project/task UI
   |       +--> 5. Volunteer dashboard/policies
   |       +--> 6. Runner registration and leasing
   |
   +--> 2. GitHub auth/app verification
   |       |
   |       +--> 4. Maintainer project/task UI
   |       +--> 8. Manual GitHub result promotion
   |
   +--> 3. Codex local integration package
           |
           +--> 7. Local runner MVP
                   |
                   +--> 9. End-to-end read-only task loop
                           |
                           +--> 10. Hardening, abuse controls, and observability
                                   |
                                   +--> 11. Patch proposals
                                   +--> 12. Desktop wrapper
                                   +--> 13. smolvm execution isolation
```

## Phase 0: Foundation

### Task 0.1: Repo Scaffold

Create the TypeScript monorepo skeleton.

Deliverables:

- `pnpm` workspace
- `apps/web`
- `apps/runner`
- `convex`
- `packages/core`
- `packages/codex`
- `packages/github`
- shared lint/typecheck/test scripts
- basic README with setup commands

Blocks:

- Everything else.

Blocked by:

- Nothing.

### Task 0.2: Shared Domain Contracts

Define the durable object shapes before implementing persistence.

Deliverables:

- task request schema
- volunteer policy schema
- runner capability schema
- lease schema
- result package schema
- task/run status enums
- validation helpers
- fixture examples

Blocks:

- Convex schema
- runner API
- web forms
- result inbox

Blocked by:

- Repo scaffold.

## Phase 1: Broker Core

### Task 1.1: Convex Schema And Core Mutations

Build the core Convex tables and transactional state transitions.

Deliverables:

- `users`
- `projects`
- `githubInstallations`
- `taskRequests`
- `runnerRegistrations`
- `volunteerProjectSubscriptions`
- `taskLeases`
- `runs`
- `resultPackages`
- `auditEvents`
- mutations for create task, activate task, register runner, lease task, heartbeat lease, complete run, fail run, expire lease

Blocks:

- maintainer UI
- volunteer UI
- runner leasing
- result inbox

Blocked by:

- Shared domain contracts.

### Task 1.2: Lease Expiry And Cleanup

Add scheduled cleanup for stale leases and runs.

Deliverables:

- scheduled lease expiry mutation
- cron or scheduled function for stale run cleanup
- audit events for lease expiration
- tests or fixtures for race cases

Blocks:

- safe runner MVP

Blocked by:

- Convex schema and core mutations.

## Phase 2: GitHub Identity And Project Verification

### Task 2.1: GitHub OAuth User Identity

Let users sign in and associate GitHub identity.

Deliverables:

- GitHub OAuth through the chosen auth setup
- Convex user record mapping
- session-aware queries/mutations
- protected routes

Blocks:

- maintainer project registration
- volunteer identity settings

Blocked by:

- Repo scaffold.

### Task 2.2: GitHub App Installation Verification

Verify that a user can register/manage a repository.

Deliverables:

- GitHub App configuration docs
- installation webhook handler
- project registration flow
- permission check for repo owner/admin/maintainer role
- installation sync mutation

Blocks:

- maintainer task creation
- later GitHub result promotion

Blocked by:

- GitHub OAuth user identity
- Convex schema.

## Phase 3: Codex Local Integration

### Task 3.1: Codex App-Server Rate-Limit Client

Turn the probe into a reusable package.

Deliverables:

- `packages/codex` app-server JSON-RPC client
- `readCodexAccountState`
- `readCodexRateLimits`
- sanitized output types
- timeout/error handling
- version detection
- tests with mocked JSONL

Blocks:

- runner capacity policy

Blocked by:

- Repo scaffold.

### Task 3.2: Codex Exec Runner

Wrap `codex exec --json --ephemeral --output-schema`.

Deliverables:

- spawn wrapper
- JSONL event parser
- final result extraction
- structured output path handling
- timeout/cancellation
- sanitized log capture
- tests with mocked process output

Blocks:

- local runner MVP

Blocked by:

- Shared domain contracts
- Codex rate-limit client can proceed in parallel, but both are needed by the runner.

## Phase 4: Web MVP

### Task 4.1: Maintainer Project And Task UI

Create the app-first task creation experience.

Deliverables:

- project list
- project registration
- task request form
- task preview
- task activation/archive
- validation errors
- basic task detail page

Blocks:

- end-to-end task loop

Blocked by:

- GitHub App verification
- Convex task mutations.

### Task 4.2: Volunteer Project Subscription And Policy UI

Let volunteers choose projects and define local runner limits.

Deliverables:

- project discovery/list
- opt-in/opt-out
- policy editor
- runner setup instructions
- runner token creation/revocation

Blocks:

- runner task matching

Blocked by:

- GitHub OAuth user identity
- Convex schema.

### Task 4.3: Maintainer Inbox

Show live task results.

Deliverables:

- inbox list
- result detail page
- run metadata
- structured output rendering
- archive/rerun decision placeholders
- live updates from Convex

Blocks:

- end-to-end validation

Blocked by:

- Convex result package schema
- runner completion mutation.

## Phase 5: Runner MVP

### Task 5.1: Runner Registration And Config

Create the local CLI setup flow.

Deliverables:

- `runner login` or token setup
- local config file
- runner registration heartbeat
- policy fetch
- project subscription fetch
- diagnostic command

Blocks:

- task leasing/execution

Blocked by:

- volunteer policy UI or manual token creation
- Convex runner registration mutations.

### Task 5.2: Runner Lease And Execute Loop

Implement the first read-only task loop.

Deliverables:

- capacity check
- eligible task lease
- clean workspace clone/update
- read-only Codex execution
- structured result upload
- failure upload
- local logs

Blocks:

- end-to-end task loop

Blocked by:

- Codex rate-limit client
- Codex exec runner
- runner registration/config
- Convex lease mutations.

## Phase 6: End-To-End MVP

### Task 6.1: First Read-Only Task Loop

Wire the whole product path together.

Deliverables:

- maintainer creates task
- volunteer opts into project
- runner leases task
- runner runs Codex locally
- result appears in maintainer inbox
- no public GitHub posting
- documented demo script

Blocks:

- private beta

Blocked by:

- maintainer task UI
- volunteer policy setup
- runner lease/execute loop
- maintainer inbox.

### Task 6.2: Safety And Abuse Controls

Add the controls needed before any outside users.

Deliverables:

- prompt linting rules
- task permission gates
- per-project/per-volunteer rate limits
- task size caps
- runner revocation
- audit log views
- result redaction pass

Blocks:

- private beta
- patch proposal work

Blocked by:

- end-to-end MVP loop.

## Phase 7: Post-MVP Extensions

### Task 7.1: Manual GitHub Result Promotion

Let maintainers promote an inbox result to GitHub manually.

Deliverables:

- create issue comment or draft issue
- create branch/PR for patch result later
- attribution controls
- preview before posting

Blocked by:

- safety controls
- GitHub App verification
- result inbox.

### Task 7.2: Patch Proposals

Allow Codex to propose patches, still requiring maintainer review.

Deliverables:

- workspace-write runner mode
- patch capture
- diff UI
- tests for patch artifact handling
- maintainer approval gate

Blocked by:

- safety controls
- read-only loop stability.

### Task 7.3: Desktop Wrapper

Wrap the runner in a local desktop app.

Deliverables:

- Tauri shell
- start/stop runner
- status menu
- capacity display
- local logs

Blocked by:

- runner MVP stability.

### Task 7.4: smolvm Isolation

Add stronger isolation for task commands/tests.

Deliverables:

- smolvm availability check
- VM workspace strategy
- command/test execution bridge
- artifact extraction
- documented limitations

Blocked by:

- patch/test task demand
- runner MVP stability.

## First Five Task Threads

Recommended first implementation order:

1. Repo scaffold.
2. Shared domain contracts.
3. Convex schema and core mutations.
4. Codex local integration package.
5. Runner registration and read-only lease loop.

The web UI can start after the Convex schema is in place. GitHub verification can start in parallel with Codex local integration once the repo scaffold exists.
