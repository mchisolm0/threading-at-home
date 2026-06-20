use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;

const DEFAULT_INTERVAL_SECONDS: u64 = 300;
const MIN_INTERVAL_SECONDS: u64 = 60;
const MAX_LOG_FILES: usize = 12;
const MAX_LOG_BYTES: usize = 48 * 1024;
const MAX_PROCESS_OUTPUT_BYTES: usize = 96 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunnerMode {
    Stopped,
    Interval,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapacitySummary {
    pub ok: bool,
    pub reasons: Vec<String>,
    pub codex_cli_version: Option<String>,
    pub rate_limit_used_percent: Option<f64>,
    pub reset_credits: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub modified_at: Option<String>,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerSnapshot {
    pub running: bool,
    pub mode: RunnerMode,
    pub interval_seconds: u64,
    pub last_started_at: Option<String>,
    pub last_completed_at: Option<String>,
    pub last_exit_code: Option<i32>,
    pub last_message: Option<String>,
    pub command_preview: String,
    pub capacity: Option<CapacitySummary>,
    pub trust_boundary: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunnerCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

#[derive(Clone, Debug)]
struct RunnerRuntime {
    running: bool,
    mode: RunnerMode,
    interval_seconds: u64,
    stop_requested: bool,
    last_started_at: Option<String>,
    last_completed_at: Option<String>,
    last_exit_code: Option<i32>,
    last_message: Option<String>,
    capacity: Option<CapacitySummary>,
}

#[derive(Clone)]
pub struct AppState {
    runtime: Arc<Mutex<RunnerRuntime>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            runtime: Arc::new(Mutex::new(RunnerRuntime {
                running: false,
                mode: RunnerMode::Stopped,
                interval_seconds: DEFAULT_INTERVAL_SECONDS,
                stop_requested: false,
                last_started_at: None,
                last_completed_at: None,
                last_exit_code: None,
                last_message: None,
                capacity: None,
            })),
        }
    }
}

#[tauri::command]
fn get_status(state: State<'_, AppState>) -> RunnerSnapshot {
    snapshot_from_runtime(&state.runtime.lock().expect("runner runtime lock"))
}

#[tauri::command]
fn run_diagnostics(state: State<'_, AppState>) -> Result<RunnerSnapshot, String> {
    let command = build_runner_command("diagnose");
    let output = run_command_capture(&command, None).map_err(sanitize_display_text)?;
    let capacity = capacity_from_diagnostics(&output.stdout);
    let message = summarize_command_output("diagnose", &output);

    {
        let mut runtime = state.runtime.lock().expect("runner runtime lock");
        runtime.last_started_at = Some(now_iso());
        runtime.last_completed_at = Some(now_iso());
        runtime.last_exit_code = Some(output.exit_code);
        runtime.last_message = Some(message);
        runtime.capacity = capacity;
    }

    Ok(snapshot_from_runtime(
        &state.runtime.lock().expect("runner runtime lock"),
    ))
}

#[tauri::command]
fn start_runner(
    interval_seconds: Option<u64>,
    state: State<'_, AppState>,
) -> Result<RunnerSnapshot, String> {
    let interval = clamp_interval(interval_seconds);
    let runtime_arc = Arc::clone(&state.runtime);

    {
        let mut runtime = runtime_arc.lock().expect("runner runtime lock");

        if runtime.running {
            return Ok(snapshot_from_runtime(&runtime));
        }

        runtime.running = true;
        runtime.mode = RunnerMode::Interval;
        runtime.interval_seconds = interval;
        runtime.stop_requested = false;
        runtime.last_started_at = Some(now_iso());
        runtime.last_message = Some("Runner interval loop started.".to_string());
    }

    thread::spawn(move || {
        loop {
            if stop_requested(&runtime_arc) {
                mark_stopped(&runtime_arc, "Runner interval loop stopped.");
                break;
            }

            let started_at = now_iso();

            {
                let mut runtime = runtime_arc.lock().expect("runner runtime lock");
                runtime.last_started_at = Some(started_at);
                runtime.last_message = Some("Running local runner once.".to_string());
            }

            let command = build_runner_command("run-once");
            let output = run_command_capture(&command, Some(Arc::clone(&runtime_arc)));
            let completed_at = now_iso();

            {
                let mut runtime = runtime_arc.lock().expect("runner runtime lock");
                runtime.last_completed_at = Some(completed_at);

                match output {
                    Ok(process_output) => {
                        runtime.last_exit_code = Some(process_output.exit_code);
                        runtime.last_message =
                            Some(summarize_command_output("run-once", &process_output));
                        runtime.capacity = capacity_from_run_once(&process_output.stdout)
                            .or_else(|| runtime.capacity.clone());
                    }
                    Err(error) => {
                        runtime.last_exit_code = None;
                        runtime.last_message = Some(sanitize_display_text(&error));
                    }
                }
            }

            for _ in 0..interval {
                if stop_requested(&runtime_arc) {
                    mark_stopped(&runtime_arc, "Runner interval loop stopped.");
                    return;
                }

                thread::sleep(Duration::from_secs(1));
            }
        }
    });

    Ok(snapshot_from_runtime(
        &state.runtime.lock().expect("runner runtime lock"),
    ))
}

#[tauri::command]
fn stop_runner(state: State<'_, AppState>) -> RunnerSnapshot {
    {
        let mut runtime = state.runtime.lock().expect("runner runtime lock");
        runtime.stop_requested = true;
        runtime.last_message =
            Some("Stop requested. Current local runner command will be cancelled.".to_string());
    }

    snapshot_from_runtime(&state.runtime.lock().expect("runner runtime lock"))
}

#[tauri::command]
fn read_logs() -> Result<Vec<LogEntry>, String> {
    read_local_logs(&default_log_dir()).map_err(sanitize_display_text)
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_status,
            run_diagnostics,
            start_runner,
            stop_runner,
            read_logs
        ])
        .run(tauri::generate_context!())
        .expect("error while running OSS Capacity desktop app");
}

fn snapshot_from_runtime(runtime: &RunnerRuntime) -> RunnerSnapshot {
    RunnerSnapshot {
        running: runtime.running,
        mode: runtime.mode.clone(),
        interval_seconds: runtime.interval_seconds,
        last_started_at: runtime.last_started_at.clone(),
        last_completed_at: runtime.last_completed_at.clone(),
        last_exit_code: runtime.last_exit_code,
        last_message: runtime.last_message.clone(),
        command_preview: command_preview(&build_runner_command("run-once")),
        capacity: runtime.capacity.clone(),
        trust_boundary: vec![
            "Codex runs locally on this machine.".to_string(),
            "Convex brokers task state and result packages.".to_string(),
            "Volunteer Codex credentials stay on this machine.".to_string(),
        ],
    }
}

fn clamp_interval(interval_seconds: Option<u64>) -> u64 {
    interval_seconds
        .unwrap_or(DEFAULT_INTERVAL_SECONDS)
        .max(MIN_INTERVAL_SECONDS)
}

fn stop_requested(runtime: &Arc<Mutex<RunnerRuntime>>) -> bool {
    runtime.lock().expect("runner runtime lock").stop_requested
}

fn mark_stopped(runtime: &Arc<Mutex<RunnerRuntime>>, message: &str) {
    let mut runtime = runtime.lock().expect("runner runtime lock");
    runtime.running = false;
    runtime.mode = RunnerMode::Stopped;
    runtime.stop_requested = false;
    runtime.last_completed_at = Some(now_iso());
    runtime.last_message = Some(message.to_string());
}

fn repo_root() -> PathBuf {
    env::var_os("OSS_CAPACITY_REPO_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            manifest_dir
                .parent()
                .and_then(Path::parent)
                .and_then(Path::parent)
                .map(Path::to_path_buf)
                .unwrap_or(manifest_dir)
        })
}

pub fn build_runner_command(action: &str) -> RunnerCommand {
    let cwd = repo_root();

    if let Some(command) = env::var_os("OSS_CAPACITY_DESKTOP_RUNNER_COMMAND") {
        let mut parts = split_command(&command.to_string_lossy());
        let program = parts
            .first()
            .cloned()
            .unwrap_or_else(|| "oss-capacity-runner".to_string());
        let mut args = parts.split_off(1);

        args.push(action.to_string());

        return RunnerCommand { program, args, cwd };
    }

    RunnerCommand {
        program: "pnpm".to_string(),
        args: vec![
            "--filter".to_string(),
            "@oss-capacity/runner".to_string(),
            "dev".to_string(),
            "--".to_string(),
            action.to_string(),
        ],
        cwd,
    }
}

fn split_command(command: &str) -> Vec<String> {
    command
        .split_whitespace()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn command_preview(command: &RunnerCommand) -> String {
    std::iter::once(command.program.as_str())
        .chain(command.args.iter().map(String::as_str))
        .map(redact_argument)
        .collect::<Vec<_>>()
        .join(" ")
}

fn redact_argument(argument: &str) -> String {
    if argument.contains("token")
        || argument.contains("auth")
        || argument.contains("secret")
        || argument.contains("credential")
    {
        "[redacted]".to_string()
    } else {
        argument.to_string()
    }
}

#[derive(Debug)]
struct ProcessOutput {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

fn run_command_capture(
    command: &RunnerCommand,
    runtime: Option<Arc<Mutex<RunnerRuntime>>>,
) -> Result<ProcessOutput, String> {
    let mut process = Command::new(&command.program);

    process
        .args(&command.args)
        .current_dir(&command.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut process);

    let mut child = process
        .spawn()
        .map_err(|error| format!("Failed to start local runner command: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Runner stdout was not captured.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Runner stderr was not captured.".to_string())?;
    let stdout_handle = read_pipe_limited(stdout);
    let stderr_handle = read_pipe_limited(stderr);
    let exit_code;

    let mut termination_requested = false;

    loop {
        if runtime.as_ref().is_some_and(stop_requested) {
            if !termination_requested {
                terminate_process_tree(child.id());
                termination_requested = true;
            }
        }

        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Runner command wait failed: {error}"))?
        {
            exit_code = status.code().unwrap_or(-1);
            break;
        }

        thread::sleep(Duration::from_millis(250));
    }

    let stdout = stdout_handle
        .join()
        .map_err(|_| "Runner stdout reader panicked.".to_string())?;
    let stderr = stderr_handle
        .join()
        .map_err(|_| "Runner stderr reader panicked.".to_string())?;

    Ok(ProcessOutput {
        exit_code,
        stdout: sanitize_display_text(&stdout),
        stderr: sanitize_display_text(&stderr),
    })
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }

            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_tree(process_id: u32) {
    let process_group = -(process_id as i32);

    unsafe {
        let _ = libc::kill(process_group, libc::SIGTERM);
    }

    thread::sleep(Duration::from_millis(750));

    unsafe {
        let _ = libc::kill(process_group, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn terminate_process_tree(process_id: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(all(not(unix), not(windows)))]
fn terminate_process_tree(_process_id: u32) {}

fn read_pipe_limited<T>(pipe: T) -> thread::JoinHandle<String>
where
    T: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut output = String::new();
        let mut line = String::new();

        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            output.push_str(&line);

            if output.len() > MAX_PROCESS_OUTPUT_BYTES {
                let start = output.len() - MAX_PROCESS_OUTPUT_BYTES;
                output = format!("[Earlier process output omitted]\n{}", &output[start..]);
            }

            line.clear();
        }

        output
    })
}

fn summarize_command_output(action: &str, output: &ProcessOutput) -> String {
    let status = if output.exit_code == 0 {
        "completed"
    } else {
        "failed"
    };
    let stderr = output.stderr.trim();

    if stderr.is_empty() {
        format!("Runner {action} {status}.")
    } else {
        format!("Runner {action} {status}: {stderr}")
    }
}

fn capacity_from_diagnostics(stdout: &str) -> Option<CapacitySummary> {
    let value: Value = serde_json::from_str(stdout).ok()?;
    let checks = value.get("checks")?.as_array()?;
    let mut reasons = Vec::new();
    let mut codex_cli_version = None;
    let mut rate_limit_used_percent = None;
    let mut reset_credits = None;

    for check in checks {
        let name = check.get("name").and_then(Value::as_str).unwrap_or("check");
        let ok = check.get("ok").and_then(Value::as_bool).unwrap_or(false);

        if !ok {
            reasons.push(format!("{name}_failed").replace('-', "_"));
        }

        if name == "codex-rate-limits" {
            let detail = check.get("detail");

            codex_cli_version = detail
                .and_then(|detail| detail.get("codexCliVersion"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            reset_credits = detail
                .and_then(|detail| detail.get("rateLimitResetCredits"))
                .and_then(Value::as_f64);
            rate_limit_used_percent = detail
                .and_then(|detail| detail.get("rateLimits"))
                .and_then(Value::as_array)
                .and_then(|limits| {
                    limits
                        .iter()
                        .filter_map(|limit| limit.get("usedPercent").and_then(Value::as_f64))
                        .max_by(f64::total_cmp)
                });
        }
    }

    Some(CapacitySummary {
        ok: value.get("ok").and_then(Value::as_bool).unwrap_or(false),
        reasons,
        codex_cli_version,
        rate_limit_used_percent,
        reset_credits,
    })
}

fn capacity_from_run_once(stdout: &str) -> Option<CapacitySummary> {
    let value: Value = serde_json::from_str(stdout).ok()?;
    let capacity = value.get("capacity")?;

    Some(CapacitySummary {
        ok: capacity.get("ok").and_then(Value::as_bool).unwrap_or(false),
        reasons: capacity
            .get("reasons")
            .and_then(Value::as_array)
            .map(|reasons| {
                reasons
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        codex_cli_version: capacity
            .get("codexCliVersion")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        rate_limit_used_percent: None,
        reset_credits: None,
    })
}

pub fn read_local_logs(log_dir: &Path) -> Result<Vec<LogEntry>, String> {
    if !log_dir.exists() {
        return Ok(Vec::new());
    }

    let mut files = fs::read_dir(log_dir)
        .map_err(|error| format!("Unable to read local runner log directory: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();

            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                return None;
            }

            let metadata = entry.metadata().ok()?;
            let modified = metadata.modified().ok();

            Some((path, modified))
        })
        .collect::<Vec<_>>();

    files.sort_by(|left, right| right.1.cmp(&left.1));

    files
        .into_iter()
        .take(MAX_LOG_FILES)
        .map(|(path, modified)| {
            let id = path
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("runner-log")
                .to_string();
            let content = read_bounded_file(&path, MAX_LOG_BYTES)?;

            Ok(LogEntry {
                id: sanitize_display_text(&id),
                modified_at: modified.map(system_time_iso),
                content: sanitize_display_text(&content),
            })
        })
        .collect()
}

fn read_bounded_file(path: &Path, max_bytes: usize) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("Unable to open runner log: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Unable to inspect runner log: {error}"))?;
    let len = metadata.len();
    let mut reader = BufReader::new(file);
    let mut content = String::new();

    if len > max_bytes as u64 {
        content.push_str("[Earlier log content omitted]\n");
    }

    let skip_lines = if len > max_bytes as u64 { 32 } else { 0 };
    let mut line = String::new();
    let mut seen_lines = 0;

    while reader.read_line(&mut line).unwrap_or(0) > 0 {
        seen_lines += 1;

        if seen_lines > skip_lines {
            content.push_str(&line);
        }

        if content.len() > max_bytes {
            let start = content.len() - max_bytes;
            content = format!("[Earlier log content omitted]\n{}", &content[start..]);
        }

        line.clear();
    }

    Ok(content)
}

fn default_log_dir() -> PathBuf {
    if let Some(path) = env::var_os("OSS_CAPACITY_RUNNER_LOG_DIR") {
        return PathBuf::from(path);
    }

    let base = env::var_os("OSS_CAPACITY_RUNNER_STATE_HOME")
        .or_else(|| env::var_os("XDG_STATE_HOME"))
        .map(PathBuf::from)
        .or_else(|| {
            #[cfg(target_os = "windows")]
            {
                env::var_os("LOCALAPPDATA")
                    .map(PathBuf::from)
                    .map(|path| path.join("oss-capacity"))
            }

            #[cfg(not(target_os = "windows"))]
            {
                env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|path| path.join(".local").join("state").join("oss-capacity"))
            }
        })
        .unwrap_or_else(|| PathBuf::from(".oss-capacity-state"));

    base.join("logs")
}

pub fn sanitize_display_text(input: impl AsRef<str>) -> String {
    let mut output = input.as_ref().to_string();
    let rules = [
        (
            r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
            "[redacted-email]",
        ),
        (r"(?i)\bsha256:[a-f0-9]{64}\b", "[redacted-hash]"),
        (
            r"(?i)\b(?:setup[-_ ]?token|runner[-_ ]?auth[-_ ]?hash|runner[-_ ]?auth[-_ ]?token|access[-_ ]?token|refresh[-_ ]?token|api[-_ ]?key|session[-_ ]?token)\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}\b",
            "[redacted-token]",
        ),
        (
            r"\b(?:sk|rk|pk|ocr)_[A-Za-z0-9._-]{8,}\b",
            "[redacted-token]",
        ),
        (r"\bsk-[A-Za-z0-9._-]{8,}\b", "[redacted-token]"),
        (
            r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b",
            "[redacted-token]",
        ),
        (
            r#"(?i)(^|[\s'"])(/(?:Users|home|tmp|var|private)/[^ "'\n]+)"#,
            "$1[redacted-path]",
        ),
        (r#"(?i)\\Users\\[^ "'\n]+"#, "[redacted-path]"),
    ];

    for (pattern, replacement) in rules {
        if let Ok(regex) = Regex::new(pattern) {
            output = regex.replace_all(&output, replacement).to_string();
        }
    }

    output
}

fn now_iso() -> String {
    system_time_iso(SystemTime::now())
}

fn system_time_iso(time: SystemTime) -> String {
    let duration = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));

    format!("{}.{:03}Z", duration.as_secs(), duration.subsec_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn default_command_wraps_runner_dev_script() {
        let command = build_runner_command("run-once");

        assert_eq!(command.program, "pnpm");
        assert_eq!(
            command.args,
            vec!["--filter", "@oss-capacity/runner", "dev", "--", "run-once"]
        );
        assert!(command.cwd.ends_with("threading-at-home"));
    }

    #[test]
    fn command_preview_redacts_sensitive_arguments() {
        let command = RunnerCommand {
            program: "oss-capacity-runner".to_string(),
            args: vec![
                "login".to_string(),
                "--setup-token".to_string(),
                "setup-token-super-secret".to_string(),
            ],
            cwd: PathBuf::from("."),
        };

        assert_eq!(
            command_preview(&command),
            "oss-capacity-runner login [redacted] [redacted]"
        );
    }

    #[test]
    fn interval_is_clamped_for_safe_polling() {
        assert_eq!(clamp_interval(Some(5)), MIN_INTERVAL_SECONDS);
        assert_eq!(clamp_interval(Some(900)), 900);
        assert_eq!(clamp_interval(None), DEFAULT_INTERVAL_SECONDS);
    }

    #[test]
    fn diagnostics_capacity_extracts_safe_summary() {
        let output = r#"{
          "ok": false,
          "checks": [
            { "name": "config", "ok": true },
            {
              "name": "codex-rate-limits",
              "ok": true,
              "detail": {
                "codexCliVersion": "0.140.0",
                "rateLimits": [
                  { "usedPercent": 67.5 },
                  { "usedPercent": 12 }
                ],
                "rateLimitResetCredits": 3
              }
            },
            { "name": "broker", "ok": false }
          ]
        }"#;

        assert_eq!(
            capacity_from_diagnostics(output),
            Some(CapacitySummary {
                ok: false,
                reasons: vec!["broker_failed".to_string()],
                codex_cli_version: Some("0.140.0".to_string()),
                rate_limit_used_percent: Some(67.5),
                reset_credits: Some(3.0),
            })
        );
    }

    #[test]
    fn local_logs_are_sorted_bounded_and_redacted() {
        let temp = tempfile::tempdir().expect("tempdir");
        let older_path = temp.path().join("older.json");
        let newer_path = temp.path().join("newer.json");
        let ignored_path = temp.path().join("ignored.txt");

        fs::write(&older_path, "person@example.com\n").expect("older log");
        fs::write(&ignored_path, "ignore me").expect("ignored log");

        let mut newer = File::create(&newer_path).expect("newer log");
        writeln!(
            newer,
            "api token: abcdefghijklmnop\npath /Users/alice/.codex/auth.json\nfinal"
        )
        .expect("write newer log");

        let logs = read_local_logs(temp.path()).expect("logs");

        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].id, "newer");
        assert!(!logs[0].content.contains("abcdefghijklmnop"));
        assert!(!logs[0].content.contains("/Users/alice"));
        assert!(!logs[1].content.contains("person@example.com"));
    }
}
