## Problem Statement

Open source maintainers increasingly have access to capable coding agents, but many still cannot justify ongoing subscription costs or do not have enough available usage when the backlog spikes. At the same time, many volunteers already pay for agent subscriptions and have unused capacity they would be willing to donate to trusted open source work.

There is no narrow, safe system that lets maintainers submit bounded work and receive useful agent output from volunteered capacity without handing over secrets, granting broad remote access, or requiring maintainers and volunteers to coordinate manually.

The problem to solve is how to let volunteers donate agent runtime safely and predictably to open source maintainers, starting with public GitHub repositories and bounded, reviewable jobs.

## Solution

Build `threading-at-home`, a system with two major parts:

- A `VolunteerNode` runtime derived from the local runtime strengths of `t3code`, responsible for polling for work, validating local policy, executing jobs through a local agent CLI, collecting artifacts, and uploading immutable results.
- A separate Convex-backed control plane responsible for maintainer job submission, GitHub normalization, scheduling, assignment leasing, heartbeat tracking, artifact indexing, and maintainer review state.

The MVP should support two job kinds:

- `report-only`: analysis output only, always read-only, no code modifications.
- `draft-pr-diff`: isolated writable execution that returns a PR-ready patch bundle and related artifacts, but does not automatically open a PR.

The first vertical slice should be a full end-to-end `report-only` flow for a pinned commit in a public GitHub repository.

## User Stories

1. As a maintainer, I want to submit a bounded `report-only` job against a public GitHub repository, so that I can receive useful agent analysis without sharing secrets.
2. As a maintainer, I want the backend to resolve GitHub URLs into canonical repo and commit metadata, so that volunteer nodes receive a normalized job definition instead of arbitrary URLs.
3. As a maintainer, I want every job to be pinned to an exact commit SHA, so that results are tied to a stable code snapshot.
4. As a maintainer, I want to ask open-ended analysis questions about a repository or issue, so that `report-only` jobs are not limited to pull request review.
5. As a maintainer, I want to bound a job by duration and budget, so that I can control cost and turnaround expectations.
6. As a maintainer, I want job results to be immutable and auditable, so that I can trust what was produced and review it later.
7. As a maintainer, I want `report-only` jobs to return a readable markdown report plus logs and metadata, so that I can evaluate the output without applying code changes.
8. As a maintainer, I want `draft-pr-diff` jobs to return a patch bundle, suggested PR text, and run metadata, so that I can apply or open a PR from trusted infrastructure later.
9. As a maintainer, I want to accept, reject, or mark a result as follow-up needed, so that the review workflow is explicit.
10. As a maintainer, I want to cancel queued or running jobs, so that I can stop work that is no longer needed.
11. As a volunteer, I want to donate only to specific allowlisted organizations and repositories, so that I control where my subscription usage goes.
12. As a volunteer, I want to choose which job kinds I allow, so that I can opt into `report-only` without allowing writable runs.
13. As a volunteer, I want provider credentials to remain local to my machine, so that donating compute does not require sharing my subscription access.
14. As a volunteer, I want read-only and writable jobs to map to explicit local runtime policies, so that I understand what the agent can do before I donate usage.
15. As a volunteer, I want web search to be a separate opt-in capability, so that network-enabled jobs require explicit approval in my local policy.
16. As a volunteer, I want a per-run isolated workspace, so that one maintainer's job cannot contaminate another run.
17. As a volunteer, I want old workspaces cleaned up automatically, so that donated work does not slowly fill my disk.
18. As a volunteer, I want max concurrency and best-effort budget caps, so that my machine and subscription are not overcommitted.
19. As the scheduler, I want lease-based assignment with heartbeat expiry, so that volunteer churn does not leave jobs permanently stuck.
20. As the backend, I want nodes to validate policy locally before accepting work, so that local safety constraints remain authoritative.
21. As the backend, I want to preserve partial artifacts for failed runs when available, so that maintainers can still get useful output from interrupted jobs.
22. As an operator, I want clear run failure classes, so that policy rejections, provider failures, node churn, and upload failures are distinguishable.
23. As an operator, I want artifact manifests with hashes, so that uploaded result bundles can be verified for completeness and integrity.
24. As a future contributor, I want shared domain contracts outside Convex storage code, so that node, backend, and maintainer web can evolve against the same protocol definitions.

## Implementation Decisions

- `threading-at-home` should be built as a new monorepo rather than by turning the current `t3code` repository directly into the product.
- The `VolunteerNode` should reuse and minimize the existing `t3code` runtime concepts for provider session management, local execution, approvals, sandbox modes, event ingestion, and run logging.
- The central backend should be a separate Convex control plane and should not execute agent runs itself.
- The first package split should include:
  - a volunteer runtime app
  - a maintainer web app
  - a Convex backend directory
  - a shared contracts package
  - a shared runtime utility package
- Shared domain and wire contracts should live outside Convex in a dedicated contracts package. Convex should own backend persistence validators, queries, mutations, actions, and indexes, but not be the only source of schema truth.
- The canonical MVP domain model should include `VolunteerNode`, `MaintainerJob`, `AssignmentLease`, `ExecutionRun`, `ResultReview`, and artifact manifest types.
- `MaintainerJob.kind` should be an explicit discriminated union with `report-only` and `draft-pr-diff`, each with distinct required fields and result schemas.
- `report-only` jobs should run in read-only mode only and must not produce file modifications as part of the accepted result contract.
- `draft-pr-diff` jobs should run in isolated writable workspaces and may return diffs, changed file manifests, and PR-ready text, but must not automatically open PRs in MVP.
- All jobs should be normalized by backend GitHub ingestion before scheduling. Nodes should not parse arbitrary GitHub issue or PR URLs to derive execution context.
- Jobs should be pinned to exact commit SHAs before they become schedulable, even if UX starts from a branch, PR, or issue URL.
- Volunteer policy should require explicit allowlists for GitHub organizations and repositories. The system should not support an `any public repo` policy in MVP.
- Volunteer policy should independently configure:
  - allowed job kinds
  - allowed providers
  - repo and org allowlists
  - max concurrent runs
  - max duration
  - web search opt-in
  - best-effort per-run and daily budget caps
- Budget caps should be treated as best-effort in MVP because provider CLIs expose token or cost telemetry after usage has already begun; enforcement can interrupt or stop a run, but cannot guarantee perfectly preemptive blocking.
- The node/backend scheduling protocol should be node-pull based, not WebSocket-first. Poll, accept, heartbeat, cancel, and upload flows are sufficient for MVP.
- Assignment should be a two-step process: the backend proposes work, the node validates local policy and accepts, and only then does the backend create the active `AssignmentLease`.
- `AssignmentLease` should include stable identifiers, attempt number, expiry, heartbeat deadlines, and a run token or equivalent capability proving authority for the current attempt.
- Nodes must revalidate local policy at acceptance time even if the backend already matched the job.
- Every `ExecutionRun` should use a fresh isolated workspace derived from a local per-repository cache or mirror, not from a previously mutated workspace.
- Workspace lifecycle should include:
  - a cached local source mirror per upstream repository
  - per-run ephemeral workspaces
  - automatic deletion by default after terminal states
  - optional retention windows for failed or recent runs
  - a background janitor enforcing retention and disk caps
- Leases should heartbeat on a short interval and expire quickly when heartbeats stop. Expired leases revoke authority to continue the run.
- Nodes must not resume expired assignments after reconnecting. Expired jobs become retryable up to a bounded attempt limit.
- The scheduler should not assign the same job to multiple nodes concurrently in MVP.
- Maintainers should be able to cancel queued or running jobs; cancellation should flow to nodes through the polling or heartbeat response path.
- Successful run artifacts should be immutable. Later maintainer actions should be recorded as `ResultReview` state, not by mutating the completed run.
- Partial artifacts should be preserved on failure when available, especially for `report-only` jobs where partial analysis may still be useful.
- Artifact uploads should include a manifest with hashes for every uploaded artifact file, such as reports, patches, logs, and metadata bundles. This is for integrity verification, auditability, and future deduplication, not for hashing every source file in the repository.
- Initial result review actions should be:
  - `accepted`
  - `rejected`
  - `follow_up_needed`
  - `apply_locally` for `draft-pr-diff` only
- The first provider path should be Codex only, while the data model remains open to future provider expansion.
- `report-only` and `draft-pr-diff` should share a common internal execution pipeline with different runtime policy and result extraction stages.
- The first production milestone should be one maintainer, one volunteer node, one public GitHub repository, and one complete end-to-end `report-only` flow.

## Testing Decisions

- Good tests should focus on external behavior and safety guarantees: policy matching, lease expiry, artifact integrity, normalized job ingestion, and user-visible run states. They should avoid asserting on incidental internal implementation details.
- The contracts package should have schema and compatibility tests for job kinds, lease payloads, artifact manifests, and review state transitions.
- The volunteer runtime should have tests for:
  - local policy validation
  - workspace lifecycle and cleanup
  - lease heartbeat and expiry handling
  - run cancellation
  - partial artifact preservation
  - best-effort budget interruption behavior
- The backend should have tests for:
  - GitHub normalization and commit pinning
  - scheduling and acceptance flow
  - retry and max-attempt semantics
  - cancellation semantics
  - failure classification
  - immutable result storage and review transitions
- The first end-to-end integration tests should cover the full `report-only` vertical slice from job submission through result review.
- Similar to the existing `t3code` codebase, the most valuable tests should target deep modules with stable interfaces and deterministic behavior under failure conditions.

## Out of Scope

- Automatic PR opening, branch pushing, or merge automation.
- Private repository support.
- Maintainer secrets on volunteer nodes.
- Anonymous or unrevocable worker identity.
- Multi-provider scheduling optimization.
- Public marketplace or broad volunteer discovery.
- Speculative duplicate execution of the same job on multiple nodes.
- Non-GitHub source control providers.
- Perfectly preemptive hard budget enforcement.
- Rich live maintainer interaction during a run.

## Further Notes

- Current Convex documentation continues to support using `convex/schema.ts` plus generated types for backend table safety and end-to-end app typing within the Convex app itself, but this does not remove the need for a separate shared contracts layer when an external worker runtime must speak the same protocol.
- The first implementation should optimize for correctness, bounded trust, and operational simplicity over scheduler sophistication.
- Once the `report-only` slice is stable, `draft-pr-diff` should be the next milestone because it exercises the same scheduling and artifact pipeline while adding writable workspace policy and diff packaging.
