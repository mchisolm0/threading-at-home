"use client";

import type { JsonValue } from "@oss-capacity/core";
import { useQuery } from "convex/react";
import Link from "next/link";

import { convexApi } from "../../../convexApi";
import {
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
