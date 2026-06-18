"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";

import { convexApi } from "../../../convexApi";

function formatLabel(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function StatusBadge({ status }: { readonly status: string }) {
  return <span className={`status-badge status-${status}`}>{status}</span>;
}

export function TaskDetailClient({ taskId }: { readonly taskId: string }) {
  const task = useQuery(convexApi.lifecycle.taskDetail, {
    taskRequestId: taskId
  });
  const activateTask = useMutation(convexApi.lifecycle.activateTask);
  const archiveTask = useMutation(convexApi.lifecycle.archiveTask);
  const [isUpdating, setIsUpdating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function updateStatus(action: "activate" | "archive") {
    if (task === undefined || task === null) {
      return;
    }

    setMessage(null);
    setIsUpdating(true);

    try {
      if (action === "activate") {
        await activateTask({
          taskRequestId: task.id,
          actorUserId: task.createdByUserId,
          now: new Date().toISOString()
        });
      } else {
        await archiveTask({
          taskRequestId: task.id,
          now: new Date().toISOString()
        });
      }

      setMessage(action === "activate" ? "Task activated" : "Task archived");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Task update failed");
    } finally {
      setIsUpdating(false);
    }
  }

  if (task === undefined) {
    return <p className="loading-copy">Loading task...</p>;
  }

  if (task === null) {
    return (
      <section className="dashboard-shell">
        <Link className="back-link" href="/dashboard">
          Back to dashboard
        </Link>
        <div className="panel">
          <p className="eyebrow">Task</p>
          <h1>Task not found</h1>
        </div>
      </section>
    );
  }

  return (
    <section className="dashboard-shell task-detail-shell">
      <Link className="back-link" href="/dashboard">
        Back to dashboard
      </Link>

      <header className="dashboard-header">
        <div>
          <p className="eyebrow">{task.projectId}</p>
          <h1>{task.title}</h1>
          <span className="header-meta">{task.id}</span>
        </div>
        <div className="session-actions">
          <button
            type="button"
            disabled={
              isUpdating ||
              task.status === "active" ||
              task.status === "archived" ||
              task.status === "expired"
            }
            onClick={() => void updateStatus("activate")}
          >
            Activate
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={isUpdating || task.status === "archived"}
            onClick={() => void updateStatus("archive")}
          >
            Archive
          </button>
        </div>
      </header>

      <div className="summary-grid">
        <div>
          <span>Status</span>
          <strong>
            <StatusBadge status={task.status} />
          </strong>
        </div>
        <div>
          <span>Type</span>
          <strong>{formatLabel(task.type)}</strong>
        </div>
        <div>
          <span>Priority</span>
          <strong>{task.priority}</strong>
        </div>
        <div>
          <span>Max runs</span>
          <strong>{task.maxRuns}</strong>
        </div>
      </div>

      <div className="detail-grid">
        <div className="panel">
          <div className="panel-heading">
            <p className="eyebrow">Request</p>
            <h2>Prompt</h2>
          </div>
          {task.description === undefined ? null : (
            <p className="detail-copy">{task.description}</p>
          )}
          <pre className="prompt-block">{task.prompt}</pre>
        </div>

        <div className="panel">
          <div className="panel-heading">
            <p className="eyebrow">Execution</p>
            <h2>Target and policy</h2>
          </div>
          <dl className="detail-list">
            <div>
              <dt>Repository</dt>
              <dd>{task.repository.fullName}</dd>
            </div>
            <div>
              <dt>Ref</dt>
              <dd>{task.target.ref ?? "not set"}</dd>
            </div>
            <div>
              <dt>Issue query</dt>
              <dd>{task.target.issueQuery ?? "not set"}</dd>
            </div>
            <div>
              <dt>Paths</dt>
              <dd>{task.target.paths?.join(", ") ?? "not set"}</dd>
            </div>
            <div>
              <dt>Sandbox</dt>
              <dd>{task.permissions.sandbox}</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>{task.permissions.network ? "enabled" : "disabled"}</dd>
            </div>
            <div>
              <dt>Patches</dt>
              <dd>{task.permissions.allowPatches ? "allowed" : "disabled"}</dd>
            </div>
            <div>
              <dt>Result visibility</dt>
              <dd>{formatLabel(task.reporting.visibility)}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{task.expiresAt ?? "not set"}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <p className="eyebrow">Preview</p>
          <h2>Stored task request</h2>
        </div>
        <pre className="json-block">{JSON.stringify(task, null, 2)}</pre>
      </div>

      {message === null ? null : <p className="status-message">{message}</p>}
    </section>
  );
}
