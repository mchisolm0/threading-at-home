"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { convexApi } from "../convexApi";

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
  const touchSession = useMutation(convexApi.users.touchSession);
  const registerProject = useAction(convexApi.github.registerProject);
  const { signOut } = useAuthActions();
  const installUrl = process.env.NEXT_PUBLIC_GITHUB_APP_INSTALL_URL;
  const [repositoryFullName, setRepositoryFullName] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (viewer === undefined) {
    return <p>Loading session...</p>;
  }

  if (viewer === null) {
    return <p>Session unavailable.</p>;
  }

  if (projects === undefined || installations === undefined) {
    return <p>Loading repositories...</p>;
  }

  return (
    <section className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p>Signed in</p>
          <h1>{viewer.displayName ?? viewer.githubLogin ?? "GitHub user"}</h1>
        </div>
        <div className="session-actions">
          <button
            type="button"
            onClick={() => {
              setMessage(null);
              void touchSession({})
                .then((updatedViewer) => {
                  setMessage(`Session checked at ${updatedViewer.updatedAt}`);
                })
                .catch(() => {
                  setMessage("Session check failed");
                });
            }}
          >
            Check session
          </button>
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <dl className="identity-grid">
        <div>
          <dt>GitHub</dt>
          <dd>{viewer.githubLogin ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>User record</dt>
          <dd>{viewer.userId}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{viewer.updatedAt}</dd>
        </div>
      </dl>

      <div className="registration-layout">
        <form
          className="registration-panel"
          onSubmit={(event) => {
            event.preventDefault();
            setMessage(null);
            setIsRegistering(true);
            void registerProject({
              repositoryFullName
            })
              .then((project) => {
                setRepositoryFullName("");
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
          <div>
            <p>Repository registration</p>
            <h2>Register a verified project</h2>
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
                <option key={`${installation.installationId}:${fullName}`} value={fullName} />
              ))
            )}
          </datalist>
          <div className="form-actions">
            <button type="submit" disabled={isRegistering}>
              {isRegistering ? "Verifying..." : "Register"}
            </button>
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
          </div>
        </form>

        <div className="registration-panel">
          <div>
            <p>GitHub App installations</p>
            <h2>Available repositories</h2>
          </div>
          {installations.length === 0 ? (
            <span className="empty-state">No installations synced yet.</span>
          ) : (
            <ul className="repo-list">
              {installations.map((installation) => (
                <li key={installation.installationId}>
                  <strong>{installation.accountLogin}</strong>
                  <span>{installation.repositoryFullNames.join(", ")}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="projects-panel">
        <div>
          <p>Verified projects</p>
          <h2>Registered repositories</h2>
        </div>
        {projects.length === 0 ? (
          <span className="empty-state">No projects registered yet.</span>
        ) : (
          <ul className="project-list">
            {projects.map((project) => (
              <li key={project.projectId}>
                <strong>{project.repository.fullName}</strong>
                <span>{project.status}</span>
                <small>{project.repository.defaultBranch ?? "default branch unknown"}</small>
              </li>
            ))}
          </ul>
        )}
      </div>

      {message === null ? null : <p className="status-message">{message}</p>}
    </section>
  );
}
