"use client";

import type {
  GitHubPromotionAttributionMode,
  GitHubPromotionPreview,
  GitHubPromotionTarget,
  JsonValue,
  PatchArtifact
} from "@oss-capacity/core";
import { useAction, useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { convexApi, type PromotionResultView } from "../../../convexApi";
import {
  diffLines,
  formatDurationMs,
  formatLabel,
  formatNumber,
  isStructuredContainer,
  structuredEntries,
  totalCommandDurationMs
} from "../resultView";

function StatusBadge({ status }: { readonly status: string }) {
  return <span className={`status-badge status-${status}`}>{status}</span>;
}

function PrimitiveValue({ value }: { readonly value: JsonValue }) {
  if (value === null) {
    return <span className="json-primitive">null</span>;
  }

  if (typeof value === "boolean") {
    return <span className="json-primitive">{value ? "true" : "false"}</span>;
  }

  return <span className="json-primitive">{String(value)}</span>;
}

function StructuredOutput({
  value,
  depth = 0
}: {
  readonly value: JsonValue;
  readonly depth?: number;
}) {
  if (!isStructuredContainer(value)) {
    return <PrimitiveValue value={value} />;
  }

  const entries = structuredEntries(value);

  if (entries.length === 0) {
    return <span className="empty-state">Empty output.</span>;
  }

  return (
    <dl className={depth === 0 ? "structured-output" : "structured-output nested"}>
      {entries.map((entry) => (
        <div className="structured-entry" key={`${depth}:${entry.key}`}>
          <dt>{entry.label}</dt>
          <dd>
            {isStructuredContainer(entry.value) ? (
              <StructuredOutput value={entry.value} depth={depth + 1} />
            ) : (
              <PrimitiveValue value={entry.value} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function PatchReviewPanel({
  resultPackageId,
  patch,
  approvals
}: {
  readonly resultPackageId: string;
  readonly patch: PatchArtifact;
  readonly approvals: readonly {
    readonly decision: string;
    readonly note?: string;
    readonly createdAt: string;
  }[];
}) {
  const recordPatchApproval = useMutation(convexApi.lifecycle.recordPatchApproval);
  const [note, setNote] = useState("");
  const [pendingDecision, setPendingDecision] = useState<"approved" | "rejected" | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const latestApproval = approvals[0];
  const lines = diffLines(patch.diff);

  async function decide(decision: "approved" | "rejected") {
    setPendingDecision(decision);
    setError(null);

    try {
      await recordPatchApproval({
        resultPackageId,
        decision,
        note: note.trim().length === 0 ? undefined : note,
        now: new Date().toISOString()
      });
      setNote("");
    } catch (approvalError) {
      setError(
        approvalError instanceof Error ? approvalError.message : String(approvalError)
      );
    } finally {
      setPendingDecision(null);
    }
  }

  return (
    <div className="panel patch-panel">
      <div className="panel-heading inline">
        <div>
          <p className="eyebrow">Patch proposal</p>
          <h2>Diff review</h2>
        </div>
        <StatusBadge status={latestApproval?.decision ?? patch.approvalStatus} />
      </div>

      <dl className="detail-list patch-metadata">
        <div>
          <dt>Base commit</dt>
          <dd>{patch.baseCommitSha ?? "not reported"}</dd>
        </div>
        <div>
          <dt>Patch SHA-256</dt>
          <dd>{patch.sha256}</dd>
        </div>
        <div>
          <dt>Files</dt>
          <dd>{formatNumber(patch.fileCount)}</dd>
        </div>
        <div>
          <dt>Bytes</dt>
          <dd>
            {formatNumber(patch.byteLength)}
            {patch.truncated ? " (truncated)" : ""}
          </dd>
        </div>
      </dl>

      {patch.changedFiles.length === 0 ? null : (
        <ul className="patch-file-list">
          {patch.changedFiles.map((file) => (
            <li key={`${file.status}:${file.oldPath ?? ""}:${file.path}`}>
              <strong>{file.path}</strong>
              <small>
                {formatLabel(file.status)}
                {file.additions === undefined ? "" : ` +${file.additions}`}
                {file.deletions === undefined ? "" : ` -${file.deletions}`}
              </small>
            </li>
          ))}
        </ul>
      )}

      <pre className="diff-block">
        {lines.map((line) => (
          <span className={`diff-line diff-${line.kind}`} key={line.key}>
            {line.text.length === 0 ? " " : line.text}
            {"\n"}
          </span>
        ))}
      </pre>

      <div className="field">
        <label htmlFor="patchReviewNote">Review note</label>
        <textarea
          id="patchReviewNote"
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>

      <div className="form-actions">
        <button
          type="button"
          disabled={pendingDecision !== null}
          onClick={() => void decide("approved")}
        >
          {pendingDecision === "approved" ? "Approving..." : "Approve patch"}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={pendingDecision !== null}
          onClick={() => void decide("rejected")}
        >
          {pendingDecision === "rejected" ? "Rejecting..." : "Reject patch"}
        </button>
      </div>

      {latestApproval === undefined ? null : (
        <p className="status-message">
          Latest decision: {latestApproval.decision} at {latestApproval.createdAt}
          {latestApproval.note === undefined ? "" : ` - ${latestApproval.note}`}
        </p>
      )}

      {error === null ? null : <p className="field-error">{error}</p>}
    </div>
  );
}

type PreviewRequest = {
  readonly resultPackageId: string;
  readonly target: GitHubPromotionTarget;
  readonly attributionMode: GitHubPromotionAttributionMode;
};

function previewTargetLabel(preview: GitHubPromotionPreview): string {
  if (preview.targetKind === "issue_comment") {
    return `${preview.targetRepository} issue #${preview.targetIssueNumber}`;
  }

  if (preview.targetKind === "new_issue") {
    return `${preview.targetRepository} new issue`;
  }

  return `${preview.targetRepository} patch pull request`;
}

function PromotionPanel({
  resultPackageId,
  defaultIssueTitle
}: {
  readonly resultPackageId: string;
  readonly defaultIssueTitle: string;
}) {
  const promoteResultToGitHub = useAction(convexApi.github.promoteResultToGitHub);
  const [targetKind, setTargetKind] =
    useState<GitHubPromotionTarget["kind"]>("issue_comment");
  const [issueNumber, setIssueNumber] = useState("");
  const [issueTitle, setIssueTitle] = useState(defaultIssueTitle);
  const [attributionMode, setAttributionMode] =
    useState<GitHubPromotionAttributionMode>("app");
  const [previewRequest, setPreviewRequest] = useState<PreviewRequest | null>(null);
  const [isPosting, setIsPosting] = useState(false);
  const [promotionResult, setPromotionResult] =
    useState<PromotionResultView | null>(null);
  const [promotionError, setPromotionError] = useState<string | null>(null);
  const preview = useQuery(
    convexApi.github.previewResultPromotion,
    previewRequest ?? "skip"
  );

  function clearPreview() {
    setPreviewRequest(null);
    setPromotionResult(null);
    setPromotionError(null);
  }

  function currentTarget(): GitHubPromotionTarget | null {
    if (targetKind === "issue_comment") {
      const parsedIssueNumber = Number(issueNumber);

      if (!Number.isInteger(parsedIssueNumber) || parsedIssueNumber < 1) {
        return null;
      }

      return {
        kind: "issue_comment",
        issueNumber: parsedIssueNumber
      };
    }

    if (targetKind === "new_issue") {
      const title = issueTitle.trim();

      if (title.length === 0) {
        return null;
      }

      return {
        kind: "new_issue",
        title
      };
    }

    return {
      kind: "patch_pull_request",
      disabledReason: "Patch pull request publishing is disabled pending maintainer approval and the next publishing slice."
    };
  }

  const target = currentTarget();
  const canPreview = target !== null;
  const canPost =
    preview !== undefined &&
    preview !== null &&
    preview.disabledReason === undefined &&
    previewRequest !== null &&
    promotionResult?.promotion.status !== "posted";

  async function postPromotion() {
    if (!canPost || previewRequest === null || preview === undefined) {
      return;
    }

    setIsPosting(true);
    setPromotionError(null);

    try {
      const result = await promoteResultToGitHub({
        ...previewRequest,
        confirmedPreviewTitle: preview.title,
        confirmedPreviewBody: preview.body
      });

      setPromotionResult(result);
      if (result.promotion.status === "failed") {
        setPromotionError(result.promotion.errorSummary ?? "GitHub promotion failed.");
      }
    } catch (error) {
      setPromotionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPosting(false);
    }
  }

  return (
    <div className="panel promotion-panel">
      <div className="panel-heading">
        <p className="eyebrow">GitHub</p>
        <h2>Manual promotion</h2>
      </div>

      <div className="promotion-controls">
        <div className="field">
          <label htmlFor="promotionTargetKind">Target</label>
          <select
            id="promotionTargetKind"
            value={targetKind}
            onChange={(event) => {
              setTargetKind(event.target.value as GitHubPromotionTarget["kind"]);
              clearPreview();
            }}
          >
            <option value="issue_comment">Issue comment</option>
            <option value="new_issue">New issue</option>
            <option value="patch_pull_request">Branch or pull request later</option>
          </select>
        </div>

        {targetKind === "issue_comment" ? (
          <div className="field">
            <label htmlFor="promotionIssueNumber">Issue number</label>
            <input
              id="promotionIssueNumber"
              inputMode="numeric"
              min="1"
              placeholder="123"
              type="number"
              value={issueNumber}
              onChange={(event) => {
                setIssueNumber(event.target.value);
                clearPreview();
              }}
            />
          </div>
        ) : null}

        {targetKind === "new_issue" ? (
          <div className="field">
            <label htmlFor="promotionIssueTitle">Issue title</label>
            <input
              id="promotionIssueTitle"
              value={issueTitle}
              onChange={(event) => {
                setIssueTitle(event.target.value);
                clearPreview();
              }}
            />
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="promotionAttribution">Attribution</label>
          <select
            id="promotionAttribution"
            value={attributionMode}
            onChange={(event) => {
              setAttributionMode(
                event.target.value as GitHubPromotionAttributionMode
              );
              clearPreview();
            }}
          >
            <option value="app">OSS Capacity only</option>
            <option value="app_with_anonymous_run">OSS Capacity and run metadata</option>
          </select>
        </div>
      </div>

      {targetKind === "patch_pull_request" ? (
        <p className="status-message">
          Branch and pull request publishing is disabled. Review and approve the captured patch before any future GitHub write path can be enabled.
        </p>
      ) : null}

      <div className="form-actions">
        <button
          type="button"
          disabled={!canPreview}
          onClick={() => {
            if (target === null) {
              return;
            }

            setPreviewRequest({
              resultPackageId,
              target,
              attributionMode
            });
            setPromotionResult(null);
            setPromotionError(null);
          }}
        >
          Preview
        </button>
        {targetKind === "patch_pull_request" ? null : (
          <button
            type="button"
            className="secondary-button"
            disabled={!canPost || isPosting}
            onClick={() => void postPromotion()}
          >
            {isPosting ? "Posting..." : "Post to GitHub"}
          </button>
        )}
      </div>

      {previewRequest !== null && preview === undefined ? (
        <span className="loading-copy">Building preview...</span>
      ) : null}

      {preview !== undefined && preview !== null ? (
        <div className="promotion-preview">
          <dl className="detail-list">
            <div>
              <dt>Target</dt>
              <dd>{previewTargetLabel(preview)}</dd>
            </div>
            <div>
              <dt>Attribution</dt>
              <dd>{preview.attributionText}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>
                {preview.source.resultPackageId} from run {preview.source.runId}
              </dd>
            </div>
            <div>
              <dt>Redaction</dt>
              <dd>{preview.redaction.applied ? "applied" : "not applied"}</dd>
            </div>
          </dl>

          {preview.title === undefined ? null : (
            <div className="field">
              <span className="field-label">Title</span>
              <pre className="prompt-block">{preview.title}</pre>
            </div>
          )}

          <div className="field">
            <span className="field-label">Body</span>
            <pre className="json-block">{preview.body}</pre>
          </div>

          {preview.disabledReason === undefined ? null : (
            <p className="status-message">{preview.disabledReason}</p>
          )}
        </div>
      ) : null}

      {promotionResult?.promotion.status === "posted" ? (
        <p className="status-message">
          Posted:{" "}
          <a href={promotionResult.promotion.targetUrl} rel="noreferrer" target="_blank">
            {promotionResult.promotion.targetUrl}
          </a>
        </p>
      ) : null}

      {promotionError === null ? null : (
        <p className="field-error">{promotionError}</p>
      )}
    </div>
  );
}

export function ResultDetailClient({
  resultPackageId
}: {
  readonly resultPackageId: string;
}) {
  const result = useQuery(convexApi.lifecycle.resultDetail, {
    resultPackageId
  });

  if (result === undefined) {
    return <p className="loading-copy">Loading result...</p>;
  }

  if (result === null) {
    return (
      <section className="dashboard-shell">
        <Link className="back-link" href="/dashboard">
          Back to dashboard
        </Link>
        <div className="panel">
          <p className="eyebrow">Result</p>
          <h1>Result not found</h1>
        </div>
      </section>
    );
  }

  const { resultPackage, run, task, project } = result;
  const commandDurationMs = totalCommandDurationMs(resultPackage);

  return (
    <section className="dashboard-shell task-detail-shell">
      <Link className="back-link" href="/dashboard">
        Back to dashboard
      </Link>

      <header className="dashboard-header">
        <div>
          <p className="eyebrow">{project.repository.fullName}</p>
          <h1>{task.title}</h1>
          <span className="header-meta">{resultPackage.resultPackageId}</span>
        </div>
        <div className="session-actions">
          <button type="button" disabled title="Result archive is not wired yet">
            Archive result
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled
            title="Rerun execution is planned for a later task"
          >
            Rerun task
          </button>
        </div>
      </header>

      <div className="summary-grid">
        <div>
          <span>Result status</span>
          <strong>
            <StatusBadge status={resultPackage.runStatus} />
          </strong>
        </div>
        <div>
          <span>Attempt</span>
          <strong>{run?.attempt ?? "unknown"}</strong>
        </div>
        <div>
          <span>Duration</span>
          <strong>
            {formatDurationMs(resultPackage.startedAt, resultPackage.completedAt)}
          </strong>
        </div>
        <div>
          <span>Total tokens</span>
          <strong>{formatNumber(resultPackage.usage?.totalTokens)}</strong>
        </div>
      </div>

      <div className="detail-grid">
        <div className="panel">
          <div className="panel-heading">
            <p className="eyebrow">Output</p>
            <h2>Summary</h2>
          </div>
          {resultPackage.summary === undefined ? (
            <span className="empty-state">No summary returned.</span>
          ) : (
            <p className="detail-copy">{resultPackage.summary}</p>
          )}

          {resultPackage.structuredOutput === undefined ? null : (
            <>
              <div className="subsection-heading">
                <span className="field-label">Structured output</span>
              </div>
              <StructuredOutput value={resultPackage.structuredOutput} />
            </>
          )}
        </div>

        <div className="panel">
          <div className="panel-heading">
            <p className="eyebrow">Run</p>
            <h2>Metadata</h2>
          </div>
          <dl className="detail-list">
            <div>
              <dt>Run id</dt>
              <dd>{resultPackage.runId}</dd>
            </div>
            <div>
              <dt>Lease id</dt>
              <dd>{resultPackage.leaseId}</dd>
            </div>
            <div>
              <dt>Runner</dt>
              <dd>{resultPackage.runnerId ?? run?.runnerId ?? "not reported"}</dd>
            </div>
            <div>
              <dt>Task</dt>
              <dd>
                <Link href={`/dashboard/tasks/${encodeURIComponent(task.id)}`}>
                  {task.id}
                </Link>
              </dd>
            </div>
            <div>
              <dt>Run status</dt>
              <dd>{run?.status ?? "not found"}</dd>
            </div>
            <div>
              <dt>Sandbox</dt>
              <dd>{resultPackage.sandbox}</dd>
            </div>
            <div>
              <dt>Visibility</dt>
              <dd>{formatLabel(resultPackage.resultVisibility)}</dd>
            </div>
            <div>
              <dt>Volunteer identity</dt>
              <dd>{formatLabel(resultPackage.volunteerVisibility)}</dd>
            </div>
            <div>
              <dt>Codex CLI</dt>
              <dd>{resultPackage.codexCliVersion ?? "not reported"}</dd>
            </div>
            <div>
              <dt>Commit</dt>
              <dd>{resultPackage.repositoryCommitSha ?? "not reported"}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{resultPackage.startedAt}</dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>{resultPackage.completedAt}</dd>
            </div>
          </dl>
        </div>
      </div>

      <PromotionPanel
        resultPackageId={resultPackage.resultPackageId}
        defaultIssueTitle={`OSS Capacity result: ${task.title}`}
      />

      {resultPackage.patchArtifact === undefined ? null : (
        <PatchReviewPanel
          resultPackageId={resultPackage.resultPackageId}
          patch={resultPackage.patchArtifact}
          approvals={result.patchApprovals}
        />
      )}

      <div className="detail-grid">
        <div className="panel">
          <div className="panel-heading">
            <p className="eyebrow">Commands</p>
            <h2>Execution summary</h2>
          </div>
          {resultPackage.commandSummaries.length === 0 ? (
            <span className="empty-state">No command summaries returned.</span>
          ) : (
            <>
              <span className="header-meta">
                {formatDurationMs(
                  resultPackage.startedAt,
                  new Date(Date.parse(resultPackage.startedAt) + commandDurationMs)
                    .toISOString()
                )}{" "}
                total command time
              </span>
              <ul className="command-list">
                {resultPackage.commandSummaries.map((command, index) => (
                  <li key={`${command.command}:${index}`}>
                    <div>
                      <strong>{command.command}</strong>
                      <StatusBadge
                        status={command.exitCode === 0 ? "completed" : "failed"}
                      />
                    </div>
                    <small>
                      exit {command.exitCode} · {formatDurationMs(
                        resultPackage.startedAt,
                        new Date(
                          Date.parse(resultPackage.startedAt) + command.durationMs
                        ).toISOString()
                      )}
                    </small>
                    <p className="detail-copy">{command.summary}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="panel">
          <div className="panel-heading">
            <p className="eyebrow">Package</p>
            <h2>Artifacts and usage</h2>
          </div>
          <dl className="detail-list">
            <div>
              <dt>Input tokens</dt>
              <dd>{formatNumber(resultPackage.usage?.inputTokens)}</dd>
            </div>
            <div>
              <dt>Cached input</dt>
              <dd>{formatNumber(resultPackage.usage?.cachedInputTokens)}</dd>
            </div>
            <div>
              <dt>Output tokens</dt>
              <dd>{formatNumber(resultPackage.usage?.outputTokens)}</dd>
            </div>
            <div>
              <dt>Reasoning tokens</dt>
              <dd>{formatNumber(resultPackage.usage?.reasoningOutputTokens)}</dd>
            </div>
          </dl>

          {resultPackage.artifacts.length === 0 ? (
            <span className="empty-state">No artifacts listed.</span>
          ) : (
            <ul className="artifact-list">
              {resultPackage.artifacts.map((artifact) => (
                <li key={artifact.storageKey}>
                  <strong>{formatLabel(artifact.kind)}</strong>
                  <small>
                    {artifact.storageKey} · {formatNumber(artifact.byteLength)} bytes
                  </small>
                  <code>{artifact.sha256}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {resultPackage.error === undefined ? null : (
        <div className="panel">
          <div className="panel-heading">
            <p className="eyebrow">Error</p>
            <h2>{resultPackage.error.code}</h2>
          </div>
          <p className="detail-copy">{resultPackage.error.message}</p>
          <StatusBadge
            status={resultPackage.error.retryable ? "retryable" : "terminal"}
          />
        </div>
      )}

      {resultPackage.warnings.length === 0 ? null : (
        <div className="panel">
          <div className="panel-heading">
            <p className="eyebrow">Warnings</p>
            <h2>Runner notes</h2>
          </div>
          <ul className="warning-list">
            {resultPackage.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="panel">
        <div className="panel-heading">
          <p className="eyebrow">Raw package</p>
          <h2>Stored result package</h2>
        </div>
        <pre className="json-block">{JSON.stringify(resultPackage, null, 2)}</pre>
      </div>
    </section>
  );
}
