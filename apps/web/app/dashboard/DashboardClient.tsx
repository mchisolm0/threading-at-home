"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import {
  publicPostingModes,
  resultVisibilityModes,
  sandboxModes,
  taskPriorities,
  taskSizes,
  taskTypes,
  type TaskRequest
} from "@oss-capacity/core";
import { useAction, useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { convexApi, type ProjectView } from "../convexApi";
import {
  buildTaskRequest,
  initialTaskForm,
  type FieldIssue,
  type TaskFormState
} from "./taskForm";

type SaveIntent = "draft" | "active";

function formatLabel(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function issuesForField(
  issues: readonly FieldIssue[],
  field: string
): readonly FieldIssue[] {
  return issues.filter((issue) => issue.field === field);
}

function FieldErrors({
  issues,
  field
}: {
  readonly issues: readonly FieldIssue[];
  readonly field: string;
}) {
  const fieldIssues = issuesForField(issues, field);

  if (fieldIssues.length === 0) {
    return null;
  }

  return (
    <span className="field-error">
      {fieldIssues.map((issue) => issue.message).join(" ")}
    </span>
  );
}

function StatusBadge({ status }: { readonly status: string }) {
  return <span className={`status-badge status-${status}`}>{status}</span>;
}

function ProjectSummary({ projects }: { readonly projects: readonly ProjectView[] }) {
  if (projects.length === 0) {
    return <span className="empty-state">No verified projects.</span>;
  }

  return (
    <ul className="project-list">
      {projects.map((project) => (
        <li key={project.projectId}>
          <strong>{project.repository.fullName}</strong>
          <StatusBadge status={project.status} />
          <small>{project.repository.defaultBranch ?? "default branch unknown"}</small>
        </li>
      ))}
    </ul>
  );
}

function TaskPreview({ task }: { readonly task: TaskRequest | null }) {
  if (task === null) {
    return <span className="empty-state">Preview unavailable.</span>;
  }

  return (
    <div className="task-preview">
      <dl>
        <div>
          <dt>Project</dt>
          <dd>{task.projectId}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{formatLabel(task.type)}</dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{task.priority}</dd>
        </div>
        <div>
          <dt>Sandbox</dt>
          <dd>{task.permissions.sandbox}</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>{task.maxRuns}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{task.expiresAt ?? "not set"}</dd>
        </div>
      </dl>
      <pre>{JSON.stringify(task, null, 2)}</pre>
    </div>
  );
}

export function DashboardClient() {
  const viewer = useQuery(convexApi.users.viewer);
  const hasViewer = viewer !== undefined && viewer !== null;
  const projects = useQuery(
    convexApi.github.myProjects,
    hasViewer ? {} : "skip"
  );
  const installations = useQuery(
    convexApi.github.availableInstallations,
    hasViewer ? {} : "skip"
  );
  const tasks = useQuery(convexApi.lifecycle.myTasks, hasViewer ? {} : "skip");
  const registerProject = useAction(convexApi.github.registerProject);
  const createTask = useMutation(convexApi.lifecycle.createTask);
  const activateTask = useMutation(convexApi.lifecycle.activateTask);
  const archiveTask = useMutation(convexApi.lifecycle.archiveTask);
  const { signOut } = useAuthActions();
  const installUrl = process.env.NEXT_PUBLIC_GITHUB_APP_INSTALL_URL;
  const [repositoryFullName, setRepositoryFullName] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [taskForm, setTaskForm] = useState<TaskFormState>(initialTaskForm());
  const [isSavingTask, setIsSavingTask] = useState<SaveIntent | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState("all");
  const [message, setMessage] = useState<string | null>(null);
  const verifiedProjects = useMemo(
    () => projects?.filter((project) => project.status === "verified") ?? [],
    [projects]
  );

  useEffect(() => {
    if (
      verifiedProjects.length > 0 &&
      taskForm.projectId.length === 0
    ) {
      setTaskForm(initialTaskForm(verifiedProjects[0].projectId));
    }
  }, [taskForm.projectId, verifiedProjects]);

  const preview = useMemo(() => {
    if (viewer === undefined || viewer === null || projects === undefined) {
      return { success: false, issues: [] as FieldIssue[] } as const;
    }

    return buildTaskRequest({
      form: taskForm,
      viewer,
      projects: verifiedProjects
    });
  }, [projects, taskForm, verifiedProjects, viewer]);
  const validationIssues = preview.success ? [] : preview.issues;
  const previewTask = preview.success ? preview.task : null;
  const filteredTasks =
    tasks?.filter(
      (task) => projectFilter === "all" || task.projectId === projectFilter
    ) ?? [];

  function updateTaskForm(patch: Partial<TaskFormState>) {
    setTaskForm((current) => ({ ...current, ...patch }));
  }

  async function submitTask(intent: SaveIntent) {
    if (viewer === undefined || viewer === null || projects === undefined) {
      return;
    }

    const result = buildTaskRequest({
      form: taskForm,
      viewer,
      projects: verifiedProjects
    });

    if (!result.success) {
      setMessage("Fix the highlighted task fields.");
      return;
    }

    setMessage(null);
    setIsSavingTask(intent);

    try {
      const created = await createTask({ task: result.task });

      if (intent === "active") {
        await activateTask({
          taskRequestId: created.id,
          actorUserId: viewer.userId,
          now: new Date().toISOString()
        });
      }

      setTaskForm(initialTaskForm(result.task.projectId));
      setMessage(
        intent === "active"
          ? `Activated ${result.task.title}`
          : `Created draft ${result.task.title}`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Task save failed");
    } finally {
      setIsSavingTask(null);
    }
  }

  async function changeTaskStatus(
    task: TaskRequest,
    action: "activate" | "archive"
  ) {
    if (viewer === undefined || viewer === null) {
      return;
    }

    setMessage(null);
    setPendingTaskId(task.id);

    try {
      if (action === "activate") {
        await activateTask({
          taskRequestId: task.id,
          actorUserId: viewer.userId,
          now: new Date().toISOString()
        });
      } else {
        await archiveTask({
          taskRequestId: task.id,
          now: new Date().toISOString()
        });
      }

      setMessage(`${action === "activate" ? "Activated" : "Archived"} ${task.title}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Task update failed");
    } finally {
      setPendingTaskId(null);
    }
  }

  if (viewer === undefined) {
    return <p className="loading-copy">Loading session...</p>;
  }

  if (viewer === null) {
    return <p className="loading-copy">Session unavailable.</p>;
  }

  if (projects === undefined || installations === undefined || tasks === undefined) {
    return <p className="loading-copy">Loading workspace...</p>;
  }

  return (
    <section className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">OSS Capacity</p>
          <h1>Maintainer workspace</h1>
          <span className="header-meta">
            {viewer.githubLogin ?? viewer.displayName ?? viewer.userId}
          </span>
        </div>
        <div className="session-actions">
          {installUrl === undefined ? null : (
            <a
              className="action-link"
              href={installUrl}
              rel="noreferrer"
              target="_blank"
            >
              Install GitHub App
            </a>
          )}
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <div className="summary-grid">
        <div>
          <span>Verified projects</span>
          <strong>{verifiedProjects.length}</strong>
        </div>
        <div>
          <span>Draft tasks</span>
          <strong>{tasks.filter((task) => task.status === "draft").length}</strong>
        </div>
        <div>
          <span>Active tasks</span>
          <strong>{tasks.filter((task) => task.status === "active").length}</strong>
        </div>
        <div>
          <span>Archived tasks</span>
          <strong>{tasks.filter((task) => task.status === "archived").length}</strong>
        </div>
      </div>

      <div className="workspace-layout">
        <div className="workspace-column">
          <form
            className="panel registration-panel"
            onSubmit={(event) => {
              event.preventDefault();
              setMessage(null);
              setIsRegistering(true);
              void registerProject({
                repositoryFullName
              })
                .then((project) => {
                  setRepositoryFullName("");
                  setTaskForm(initialTaskForm(project.projectId));
                  setMessage(`Registered ${project.repository.fullName}`);
                })
                .catch((error: unknown) => {
                  setMessage(
                    error instanceof Error
                      ? error.message
                      : "Could not register repository"
                  );
                })
                .finally(() => {
                  setIsRegistering(false);
                });
            }}
          >
            <div className="panel-heading">
              <p className="eyebrow">Projects</p>
              <h2>Register repository</h2>
            </div>
            <label htmlFor="repositoryFullName">Repository</label>
            <input
              id="repositoryFullName"
              name="repositoryFullName"
              list="installedRepositories"
              placeholder="owner/repo"
              value={repositoryFullName}
              onChange={(event) => setRepositoryFullName(event.target.value)}
              required
              pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
            />
            <datalist id="installedRepositories">
              {installations.flatMap((installation) =>
                installation.repositoryFullNames.map((fullName) => (
                  <option
                    key={`${installation.installationId}:${fullName}`}
                    value={fullName}
                  />
                ))
              )}
            </datalist>
            <button type="submit" disabled={isRegistering}>
              {isRegistering ? "Verifying..." : "Register"}
            </button>
          </form>

          <div className="panel">
            <div className="panel-heading">
              <p className="eyebrow">Projects</p>
              <h2>Registered repositories</h2>
            </div>
            <ProjectSummary projects={projects} />
          </div>

          <div className="panel">
            <div className="panel-heading">
              <p className="eyebrow">GitHub App</p>
              <h2>Installations</h2>
            </div>
            {installations.length === 0 ? (
              <span className="empty-state">No installations synced.</span>
            ) : (
              <ul className="repo-list">
                {installations.map((installation) => (
                  <li key={installation.installationId}>
                    <strong>{installation.accountLogin}</strong>
                    <StatusBadge status={installation.status} />
                    <small>{installation.repositoryFullNames.join(", ")}</small>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="workspace-column wide">
          <form
            className="panel task-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitTask("draft");
            }}
          >
            <div className="panel-heading">
              <p className="eyebrow">Tasks</p>
              <h2>Request work</h2>
            </div>

            <div className="form-grid">
              <div className="field full">
                <label htmlFor="taskProject">Project</label>
                <select
                  id="taskProject"
                  value={taskForm.projectId}
                  onChange={(event) =>
                    updateTaskForm({ projectId: event.target.value })
                  }
                >
                  <option value="">Select project</option>
                  {verifiedProjects.map((project) => (
                    <option key={project.projectId} value={project.projectId}>
                      {project.repository.fullName}
                    </option>
                  ))}
                </select>
                <FieldErrors issues={validationIssues} field="projectId" />
              </div>

              <div className="field full">
                <label htmlFor="taskTitle">Title</label>
                <input
                  id="taskTitle"
                  value={taskForm.title}
                  maxLength={160}
                  onChange={(event) =>
                    updateTaskForm({ title: event.target.value })
                  }
                />
                <FieldErrors issues={validationIssues} field="title" />
              </div>

              <div className="field full">
                <label htmlFor="taskDescription">Description</label>
                <textarea
                  id="taskDescription"
                  value={taskForm.description}
                  maxLength={2000}
                  rows={3}
                  onChange={(event) =>
                    updateTaskForm({ description: event.target.value })
                  }
                />
                <FieldErrors issues={validationIssues} field="description" />
              </div>

              <div className="field">
                <label htmlFor="taskType">Type</label>
                <select
                  id="taskType"
                  value={taskForm.type}
                  onChange={(event) =>
                    updateTaskForm({ type: event.target.value as TaskFormState["type"] })
                  }
                >
                  {taskTypes.map((type) => (
                    <option key={type} value={type}>
                      {formatLabel(type)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="taskPriority">Priority</label>
                <select
                  id="taskPriority"
                  value={taskForm.priority}
                  onChange={(event) =>
                    updateTaskForm({
                      priority: event.target.value as TaskFormState["priority"]
                    })
                  }
                >
                  {taskPriorities.map((priority) => (
                    <option key={priority} value={priority}>
                      {priority}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="taskSize">Size</label>
                <select
                  id="taskSize"
                  value={taskForm.expectedSize}
                  onChange={(event) =>
                    updateTaskForm({
                      expectedSize: event.target.value as TaskFormState["expectedSize"]
                    })
                  }
                >
                  {taskSizes.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="taskMaxRuns">Max runs</label>
                <input
                  id="taskMaxRuns"
                  type="number"
                  min={1}
                  max={100}
                  value={taskForm.maxRuns}
                  onChange={(event) =>
                    updateTaskForm({ maxRuns: event.target.value })
                  }
                />
                <FieldErrors issues={validationIssues} field="maxRuns" />
              </div>

              <div className="field">
                <label htmlFor="targetRef">Target ref</label>
                <input
                  id="targetRef"
                  value={taskForm.targetRef}
                  placeholder={
                    verifiedProjects.find(
                      (project) => project.projectId === taskForm.projectId
                    )
                      ?.repository.defaultBranch ?? "main"
                  }
                  onChange={(event) =>
                    updateTaskForm({ targetRef: event.target.value })
                  }
                />
                <FieldErrors issues={validationIssues} field="target" />
              </div>

              <div className="field">
                <label htmlFor="expiresAtLocal">Expires</label>
                <input
                  id="expiresAtLocal"
                  type="datetime-local"
                  value={taskForm.expiresAtLocal}
                  onChange={(event) =>
                    updateTaskForm({ expiresAtLocal: event.target.value })
                  }
                />
                <FieldErrors issues={validationIssues} field="expiresAtLocal" />
                <FieldErrors issues={validationIssues} field="expiresAt" />
              </div>

              <div className="field full">
                <label htmlFor="issueQuery">Issue query</label>
                <input
                  id="issueQuery"
                  value={taskForm.issueQuery}
                  placeholder="is:open label:needs-triage"
                  onChange={(event) =>
                    updateTaskForm({ issueQuery: event.target.value })
                  }
                />
              </div>

              <div className="field full">
                <label htmlFor="paths">Paths</label>
                <textarea
                  id="paths"
                  rows={2}
                  value={taskForm.paths}
                  placeholder="packages/core/src/contracts.ts"
                  onChange={(event) =>
                    updateTaskForm({ paths: event.target.value })
                  }
                />
              </div>

              <div className="field">
                <label htmlFor="sandbox">Sandbox</label>
                <select
                  id="sandbox"
                  value={taskForm.sandbox}
                  onChange={(event) =>
                    updateTaskForm({
                      sandbox: event.target.value as TaskFormState["sandbox"]
                    })
                  }
                >
                  {sandboxModes.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="publicPosting">Public posting</label>
                <select
                  id="publicPosting"
                  value={taskForm.publicPosting}
                  onChange={(event) =>
                    updateTaskForm({
                      publicPosting:
                        event.target.value as TaskFormState["publicPosting"]
                    })
                  }
                >
                  {publicPostingModes.map((mode) => (
                    <option key={mode} value={mode}>
                      {formatLabel(mode)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="resultVisibility">Result visibility</label>
                <select
                  id="resultVisibility"
                  value={taskForm.resultVisibility}
                  onChange={(event) =>
                    updateTaskForm({
                      resultVisibility:
                        event.target.value as TaskFormState["resultVisibility"]
                    })
                  }
                >
                  {resultVisibilityModes.map((mode) => (
                    <option key={mode} value={mode}>
                      {formatLabel(mode)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="toggle-row">
                <label>
                  <input
                    type="checkbox"
                    checked={taskForm.network}
                    onChange={(event) =>
                      updateTaskForm({ network: event.target.checked })
                    }
                  />
                  Network
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={taskForm.allowPatches}
                    onChange={(event) =>
                      updateTaskForm({ allowPatches: event.target.checked })
                    }
                  />
                  Patches
                </label>
              </div>

              <div className="field full">
                <label htmlFor="prompt">Prompt</label>
                <textarea
                  id="prompt"
                  rows={8}
                  value={taskForm.prompt}
                  onChange={(event) =>
                    updateTaskForm({ prompt: event.target.value })
                  }
                />
                <FieldErrors issues={validationIssues} field="prompt" />
              </div>

              <div className="field full">
                <label htmlFor="outputSchema">Output schema</label>
                <textarea
                  id="outputSchema"
                  rows={8}
                  spellCheck={false}
                  value={taskForm.outputSchema}
                  onChange={(event) =>
                    updateTaskForm({ outputSchema: event.target.value })
                  }
                />
                <FieldErrors issues={validationIssues} field="outputSchema" />
              </div>
            </div>

            <div className="form-actions">
              <button
                type="submit"
                disabled={isSavingTask !== null || verifiedProjects.length === 0}
              >
                {isSavingTask === "draft" ? "Saving..." : "Save draft"}
              </button>
              <button
                type="button"
                disabled={isSavingTask !== null || verifiedProjects.length === 0}
                onClick={() => void submitTask("active")}
              >
                {isSavingTask === "active" ? "Activating..." : "Save and activate"}
              </button>
            </div>
          </form>

          <div className="panel">
            <div className="panel-heading">
              <p className="eyebrow">Preview</p>
              <h2>Task request</h2>
            </div>
            <TaskPreview task={previewTask} />
          </div>
        </div>
      </div>

      <div className="panel tasks-panel">
        <div className="panel-heading inline">
          <div>
            <p className="eyebrow">Tasks</p>
            <h2>Requests</h2>
          </div>
          <label className="filter-control" htmlFor="projectFilter">
            Project
            <select
              id="projectFilter"
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
            >
              <option value="all">All</option>
              {projects.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.repository.fullName}
                </option>
              ))}
            </select>
          </label>
        </div>

        {filteredTasks.length === 0 ? (
          <span className="empty-state">No task requests.</span>
        ) : (
          <div className="task-table">
            <div className="task-table-head">
              <span>Task</span>
              <span>Project</span>
              <span>Status</span>
              <span>Priority</span>
              <span>Updated</span>
              <span>Actions</span>
            </div>
            {filteredTasks.map((task) => (
              <div className="task-row" key={task.id}>
                <Link href={`/dashboard/tasks/${encodeURIComponent(task.id)}`}>
                  {task.title}
                </Link>
                <span>{task.projectId}</span>
                <StatusBadge status={task.status} />
                <span>{task.priority}</span>
                <time dateTime={task.updatedAt}>{task.updatedAt}</time>
                <div className="row-actions">
                  <button
                    type="button"
                    disabled={
                      pendingTaskId === task.id ||
                      task.status === "active" ||
                      task.status === "archived" ||
                      task.status === "expired"
                    }
                    onClick={() => void changeTaskStatus(task, "activate")}
                  >
                    Activate
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={pendingTaskId === task.id || task.status === "archived"}
                    onClick={() => void changeTaskStatus(task, "archive")}
                  >
                    Archive
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {message === null ? null : <p className="status-message">{message}</p>}
    </section>
  );
}
