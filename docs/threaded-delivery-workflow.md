# Threaded Delivery Workflow

This workflow is for implementing OSS Capacity through Codex threads while keeping one parent coordinator thread in control.

## Roles

### Parent Coordinator Thread

The parent thread owns the roadmap and starts one implementation task at a time. It does not implement every task itself.

Responsibilities:

- choose the next unblocked task from `docs/implementation-roadmap.md`
- create a task thread with a precise assignment
- wait for the task thread to report completion or blockage
- review links to PRs and final status
- start the next task thread

### Task Thread

The task thread owns one implementation slice.

Responsibilities:

- create or switch to a task branch
- implement the assigned task
- run relevant checks
- create a review thread when it thinks it is done
- fix review feedback
- push the branch and open a PR
- monitor the PR for comments/checks
- address comments until clear
- create a final review/merge thread
- report back to the parent coordinator thread

### Review Thread

The review thread inspects a task branch or PR.

Responsibilities:

- review for correctness, security, product fit, and tests
- leave actionable comments or report no issues
- avoid unrelated refactors
- report findings back to the task thread

### Final Review/Merge Thread

The final review thread does a final PR review after normal review comments are addressed.

Responsibilities:

- confirm checks pass
- confirm requested changes are addressed
- perform final review
- merge if ready and permitted
- report final merge status back to the task thread

## Important Constraint

The task thread should not start the next roadmap task. It reports back to the parent coordinator, and the parent starts the next task. This keeps sequencing and blockers sane.

## Parent Coordinator Procedure

1. Read `docs/implementation-roadmap.md`.
2. Pick the first task whose blockers are complete.
3. Create a new task thread with the prompt template below.
4. Track the task thread id and task id.
5. Wait for the task thread to report one of:
   - completed and merged
   - completed but not merged, with reason
   - blocked, with exact blocker
6. Update the roadmap status if appropriate.
7. Start the next unblocked task thread.

## Task Thread Prompt Template

Use this prompt when starting a new implementation thread.

```text
You are implementing one task for the OSS Capacity project.

Parent coordinator thread context:
- Product docs live in docs/codex-oss-capacity-research.md, docs/oss-capacity-app-plan.md, docs/implementation-roadmap.md, and docs/threaded-delivery-workflow.md.
- Follow the roadmap blockers. Do not start unrelated roadmap tasks.
- Keep the trust boundary intact: volunteer Codex credentials never leave the volunteer machine, Convex brokers state, and Codex runs locally in the runner.

Assigned task:
- Task id: <TASK_ID>
- Task name: <TASK_NAME>
- Task description: <TASK_DESCRIPTION>
- Deliverables:
  - <DELIVERABLE_1>
  - <DELIVERABLE_2>
  - <DELIVERABLE_3>
- Explicitly out of scope:
  - <OUT_OF_SCOPE_1>
  - <OUT_OF_SCOPE_2>

Required workflow:
1. Inspect the repo and confirm the task is unblocked.
2. Create or switch to a branch named codex/<TASK_ID>-<short-slug>.
3. Implement only this task's deliverables.
4. Run the relevant checks. If checks cannot run, document why.
5. When you think the task is complete, create another new thread asking for review. Give it the branch, changed files, task intent, and what checks passed.
6. Fix anything addressed in review.
7. When review feedback is resolved, push the code and create a pull request.
8. Watch the PR for review comments and failing checks. Address comments/checks until no actionable comments remain.
9. Once comments are addressed, create another new thread asking for final PR review and merge if ready.
10. After final review/merge, report back to the parent coordinator thread with:
    - task id
    - branch
    - PR URL
    - merge status
    - checks run
    - any follow-up tasks discovered

Do not merge without final review approval. Do not start the next roadmap task.
```

## Review Thread Prompt Template

```text
Please review this OSS Capacity implementation task.

Task:
- Task id: <TASK_ID>
- Task name: <TASK_NAME>
- Intended deliverables:
  - <DELIVERABLE_1>
  - <DELIVERABLE_2>

Branch or PR:
- <BRANCH_OR_PR_URL>

Changed files:
- <FILE_1>
- <FILE_2>

Review focus:
- correctness against the assigned task
- missing tests or checks
- security/trust-boundary issues
- Convex data/model consistency, if relevant
- runner credential safety, if relevant
- product scope creep

Please lead with findings ordered by severity. If there are no issues, say so clearly and mention residual risk or test gaps.
```

## Final Review/Merge Thread Prompt Template

```text
Please do a final review of this OSS Capacity pull request and merge it if ready.

PR:
- <PR_URL>

Task:
- Task id: <TASK_ID>
- Task name: <TASK_NAME>

Before merging, confirm:
- all actionable review comments are addressed
- required checks pass or any failures are understood and acceptable
- the PR is scoped to the assigned task
- no volunteer Codex credentials or sensitive data are introduced
- no public GitHub posting or write actions are added unless the task explicitly allowed them

If ready, merge the PR. If not ready, report the blockers clearly back to the task thread.
```

## PR Monitoring Rules

The task thread should keep watching until one of these is true:

- PR is merged.
- PR is explicitly blocked by a maintainer decision.
- CI or reviews require external credentials or decisions the task thread cannot resolve.
- The parent coordinator stops or redirects the task.

When addressing comments:

- Prefer small follow-up commits.
- Do not rewrite unrelated history unless the PR owner requests it.
- Do not expand scope to the next roadmap task.
- Re-run relevant checks after fixes.

## Completion Report Template

```text
Task complete.

Task id:
Branch:
PR:
Merged: yes/no
Checks run:
Review threads created:
Final review thread:
Follow-up tasks discovered:
Blockers or caveats:
```

## When To Block

A task thread should report blocked instead of improvising when:

- the assigned task depends on a missing previous roadmap task
- GitHub credentials/app installation are unavailable
- Convex deployment credentials are unavailable
- required secrets are missing
- a terms/security question changes the product trust boundary
- the task would require public posting, PR creation, or credential handling outside the assigned scope
