import { invoke } from "@tauri-apps/api/core";

import "./styles.css";
import {
  formatPercent,
  reasonLabel,
  snapshotToViewModel,
  type LogEntry,
  type RunnerSnapshot
} from "./runnerUi";

const root = document.querySelector<HTMLDivElement>("#app");

if (root === null) {
  throw new Error("Missing app root");
}

const appRoot = root;
let snapshot: RunnerSnapshot | undefined;
let logs: readonly LogEntry[] = [];
let busyAction: string | undefined;
let errorMessage: string | undefined;

function setBusy(action: string | undefined): void {
  busyAction = action;
  render();
}

async function callCommand<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    errorMessage = undefined;
    return await invoke<T>(name, args);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    render();
  }
}

async function refresh(): Promise<void> {
  setBusy("refresh");
  try {
    snapshot = await callCommand<RunnerSnapshot>("get_status");
    logs = await callCommand<readonly LogEntry[]>("read_logs");
  } finally {
    setBusy(undefined);
  }
}

async function runDiagnostics(): Promise<void> {
  setBusy("diagnostics");
  try {
    snapshot = await callCommand<RunnerSnapshot>("run_diagnostics");
    logs = await callCommand<readonly LogEntry[]>("read_logs");
  } finally {
    setBusy(undefined);
  }
}

async function startRunner(): Promise<void> {
  setBusy("start");
  try {
    snapshot = await callCommand<RunnerSnapshot>("start_runner", {
      intervalSeconds: 300
    });
  } finally {
    setBusy(undefined);
  }
}

async function stopRunner(): Promise<void> {
  setBusy("stop");
  try {
    snapshot = await callCommand<RunnerSnapshot>("stop_runner");
    logs = await callCommand<readonly LogEntry[]>("read_logs");
  } finally {
    setBusy(undefined);
  }
}

function button(label: string, action: string, disabled: boolean): string {
  return `<button data-action="${action}" ${disabled ? "disabled" : ""}>${label}</button>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function render(): void {
  const current =
    snapshot ??
    ({
      running: false,
      mode: "stopped",
      intervalSeconds: 300,
      commandPreview: "Loading runner command...",
      trustBoundary: [
        "Codex runs locally on this machine.",
        "Convex brokers task state and result packages.",
        "Volunteer Codex credentials stay on this machine."
      ]
    } satisfies RunnerSnapshot);
  const view = snapshotToViewModel(current);
  const capacity = current.capacity;
  const capacityReasons =
    view.capacityReasons.length === 0
      ? "<li>No blocking capacity reason reported.</li>"
      : view.capacityReasons.map((reason) => `<li>${escapeHtml(reasonLabel(reason))}</li>`).join("");
  const logMarkup =
    logs.length === 0
      ? "<p class=\"empty\">No local runner logs found.</p>"
      : logs
          .map(
            (entry) => `
              <article class="log-entry">
                <div class="log-meta">
                  <strong>${escapeHtml(entry.id)}</strong>
                  <span>${escapeHtml(entry.modifiedAt ?? "")}</span>
                </div>
                <pre>${escapeHtml(entry.content)}</pre>
              </article>
            `
          )
          .join("");

  appRoot.innerHTML = `
    <section class="shell">
      <aside class="status-menu">
        <div>
          <p class="eyebrow">OSS Capacity</p>
          <h1>Runner</h1>
        </div>
        <nav aria-label="Runner status">
          <a href="#status">Status</a>
          <a href="#capacity">Capacity</a>
          <a href="#logs">Local logs</a>
        </nav>
        <div class="trust">
          <h2>Trust Boundary</h2>
          <ul>
            ${current.trustBoundary.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </div>
      </aside>
      <section class="workspace">
        <header id="status" class="topbar">
          <div>
            <span class="badge ${view.badgeTone}">${view.statusLabel}</span>
            <h2>Local volunteer runner</h2>
            <p>${escapeHtml(current.lastMessage ?? "Ready to check local runner state.")}</p>
          </div>
          <div class="actions">
            ${button("Refresh", "refresh", busyAction !== undefined)}
            ${button("Diagnose", "diagnostics", busyAction !== undefined)}
            ${button("Start", "start", busyAction !== undefined || current.running)}
            ${button("Stop", "stop", busyAction !== undefined || !current.running)}
          </div>
        </header>

        ${
          errorMessage === undefined
            ? ""
            : `<p class="notice warn-text">${escapeHtml(errorMessage)}</p>`
        }

        <section id="capacity" class="grid">
          <div class="panel">
            <h3>Capacity</h3>
            <p class="metric">${view.capacityLabel}</p>
            <dl>
              <div>
                <dt>Rate limit</dt>
                <dd>${formatPercent(capacity?.rateLimitUsedPercent)}</dd>
              </div>
              <div>
                <dt>Reset credits</dt>
                <dd>${capacity?.resetCredits ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Codex CLI</dt>
                <dd>${escapeHtml(capacity?.codexCliVersion ?? "Unknown")}</dd>
              </div>
            </dl>
            <ul class="reason-list">${capacityReasons}</ul>
          </div>

          <div class="panel">
            <h3>Run loop</h3>
            <dl>
              <div>
                <dt>Mode</dt>
                <dd>${escapeHtml(current.mode)}</dd>
              </div>
              <div>
                <dt>Interval</dt>
                <dd>${current.intervalSeconds}s</dd>
              </div>
              <div>
                <dt>Last started</dt>
                <dd>${escapeHtml(current.lastStartedAt ?? "Never")}</dd>
              </div>
              <div>
                <dt>Last completed</dt>
                <dd>${escapeHtml(current.lastCompletedAt ?? "Never")}</dd>
              </div>
              <div>
                <dt>Last exit</dt>
                <dd>${current.lastExitCode ?? "None"}</dd>
              </div>
            </dl>
          </div>
        </section>

        <section class="panel command-panel">
          <h3>Command surface</h3>
          <p>The shell calls the existing local runner CLI and displays only redacted, bounded output.</p>
          <code>${escapeHtml(current.commandPreview)}</code>
        </section>

        <section id="logs" class="logs">
          <div class="section-heading">
            <h3>Local logs</h3>
            <p>Newest bounded runner log files from local state storage.</p>
          </div>
          ${logMarkup}
        </section>
      </section>
    </section>
  `;
}

appRoot.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action = target.dataset.action;

  if (action === "refresh") {
    void refresh();
  } else if (action === "diagnostics") {
    void runDiagnostics();
  } else if (action === "start") {
    void startRunner();
  } else if (action === "stop") {
    void stopRunner();
  }
});

render();
void refresh();
