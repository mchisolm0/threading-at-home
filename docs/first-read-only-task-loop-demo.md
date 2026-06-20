# First Read-Only Task Loop Demo

This demo verifies the Task 6.1 MVP path:

1. A maintainer creates and activates a read-only task.
2. A volunteer opts into the project and saves an upload-ready policy.
3. The volunteer registers a local runner.
4. `oss-capacity-runner run-once` leases the task.
5. Codex runs locally on the volunteer machine in read-only mode.
6. The result appears in the maintainer inbox.

The runner never uploads volunteer Codex credentials to Convex. Convex stores task, lease, runner, and result state only. The runner does not post to GitHub, create branches, open pull requests, or write public comments.

## Required Live Services

For a true browser demo, configure:

- Convex deployment URL in `NEXT_PUBLIC_CONVEX_URL`.
- Convex Auth GitHub OAuth values documented in `README.md`.
- GitHub App installation values documented in `docs/github-app-configuration.md`.
- A local Codex CLI session on the volunteer machine.

Do not put secrets in committed files.

## Start The App

```sh
pnpm install
pnpm build
NEXT_PUBLIC_CONVEX_URL=https://<deployment>.convex.cloud pnpm dev
```

Open `http://localhost:3000`, sign in with GitHub, and open the dashboard.

## Maintainer Script

1. Register a repository that is installed in the GitHub App.
2. In `Request work`, keep these MVP-safe task settings:
   - `Sandbox`: `read-only`
   - `Network`: unchecked
   - `Patches`: unchecked
   - `Public posting`: `maintainer only`
   - `Result visibility`: `maintainer only`
3. Enter a small analysis or triage prompt. Private-beta safety linting rejects prompts that ask Codex to post publicly, write patches, run shell commands or scripts, use network access, request credentials, or inspect volunteer-local secret paths.
4. Keep or edit the output schema as a JSON object. Small tasks are capped at 4,000 prompt characters, 6,000 serialized output-schema characters, and 3 runs.
5. Click `Save and activate`.

## Volunteer Script

1. In `Capacity and limits`, enable runner matching.
2. Set `Max task size` to at least the task size.
3. Keep `Max sandbox` as `read-only`.
4. Keep `Allow network` and `Allow patches` unchecked.
5. Uncheck `Review before upload`.
6. Keep `Review before public posting` checked.
7. In `Volunteer opt-in`, make sure `Allow` is checked for the maintainer project.
8. Click `Save policy` so the project allowlist is persisted.
9. In `Volunteer opt-in`, click `Opt in` for the maintainer project.
10. In `Setup tokens`, create a token and copy the displayed one-time token.

This demo intentionally skips leasing when `Review before upload` is enabled. The future local review-before-upload workflow is out of scope for this demo.

## Runner Script

Run these commands on the volunteer machine that already has Codex authenticated locally:

```sh
pnpm --filter @oss-capacity/runner build
pnpm --filter @oss-capacity/runner exec oss-capacity-runner login \
  --broker-url https://<deployment>.convex.cloud \
  --setup-token <one-time-setup-token> \
  --name "Local read-only demo runner"

pnpm --filter @oss-capacity/runner exec oss-capacity-runner diagnose
pnpm --filter @oss-capacity/runner exec oss-capacity-runner run-once
```

If a volunteer revokes a registered runner in the dashboard, subsequent `diagnose`, `heartbeat`, or `run-once` calls fail with a revoked-runner diagnostic. Re-run `login` with a fresh setup token to register that machine again.

Expected `run-once` output:

- `status` is `completed` for a successful Codex run, or `failed` if Codex returned a terminal failure that was uploaded.
- `lease.taskRequestId` matches the activated task.
- `capacity.ok` is `true`.

The runner invokes Codex with `codex exec --json --ephemeral --sandbox read-only` and disables shell environment inheritance for the Codex child process.

## Maintainer Inbox Check

Return to the dashboard and confirm:

- The inbox contains a new result for the activated task.
- The result detail page shows the structured output and command summary.
- No GitHub issue comment, pull request, branch, or public post was created by the runner.
- Audit panels show scoped task, lease, run, setup-token, and runner-revocation events without runner auth hashes or volunteer Codex credentials.

## Optional Manual GitHub Promotion

Maintainers can promote a redacted inbox result from the result detail page after configuring the GitHub App with Issues write permission.

1. Open a result detail page.
2. Choose `Issue comment` with a target issue number, or `New issue` with a title.
3. Choose attribution as `OSS Capacity only` or `OSS Capacity and run metadata`.
4. Click `Preview` and inspect the exact repository, target, body, attribution, source metadata, and redaction state.
5. Click `Post to GitHub` only if the preview is ready to publish.

Promotion is always maintainer-initiated and uses the verified GitHub App installation token. Branch and pull request promotion is visible as a disabled future target until patch artifacts and the Task 7.2 approval flow exist.

## Local Mock Verification

Automated tests must not run live Codex or require GitHub/Convex secrets. The runner CLI test suite includes a mocked successful loop that verifies leasing, read-only Codex invocation, result upload, and sanitized output.

```sh
pnpm build
pnpm --filter @oss-capacity/runner test
```
