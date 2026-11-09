//! Tauri glue: commands and events for the UI in ../ui. The installer logic
//! lives in `core`, which knows nothing about Tauri.

pub mod core;

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::core::{
    detect, ops, Branch, Detection, Env, FailCode, Failure, InstallRequest, OpError, PlanStep, ProgressEvent, Reporter,
    Summary, UninstallRequest,
};

/// A per-session log file in %LOCALAPPDATA%\DopasPurifier\logs.
pub struct FileLog {
    file: Mutex<Option<fs::File>>,
    pub path: Option<PathBuf>,
}

impl FileLog {
    pub fn open(env: &Env) -> FileLog {
        let dir = env.logs_dir();
        let _ = fs::create_dir_all(&dir);
        // Keep the newest ten logs.
        if let Ok(rd) = fs::read_dir(&dir) {
            let mut old: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("setup-")))
                .collect();
            old.sort();
            while old.len() >= 10 {
                let _ = fs::remove_file(old.remove(0));
            }
        }
        let path = dir.join(format!("setup-{}.log", chrono::Local::now().format("%Y%m%d-%H%M%S")));
        let file = fs::OpenOptions::new().create(true).append(true).open(&path).ok();
        let ok = file.is_some();
        FileLog { file: Mutex::new(file), path: ok.then_some(path) }
    }

    pub fn line(&self, s: &str) {
        if let Ok(mut guard) = self.file.lock() {
            if let Some(f) = guard.as_mut() {
                let _ = writeln!(f, "{} {}", chrono::Local::now().format("%H:%M:%S%.3f"), s);
                let _ = f.flush();
            }
        }
    }
}

pub struct AppState {
    env: Arc<Env>,
    busy: AtomicBool,
    log: Arc<FileLog>,
}

/// Sends core progress to the window as `plan`, `progress` and `log` events.
struct TauriReporter {
    app: AppHandle,
    log: Arc<FileLog>,
}

#[derive(Clone, Serialize)]
struct LogEvent<'a> {
    line: &'a str,
}

impl Reporter for TauriReporter {
    fn plan(&self, steps: &[PlanStep]) {
        let _ = self.app.emit("plan", steps);
        self.log.line(&format!("plan: {}", steps.iter().map(|s| s.id.as_str()).collect::<Vec<_>>().join(", ")));
    }
    fn progress(&self, ev: &ProgressEvent) {
        let _ = self.app.emit("progress", ev);
        self.log.line(&format!("step {} {:?} {:.1}% {}", ev.step, ev.state, ev.pct, ev.detail));
    }
    fn log(&self, line: &str) {
        let _ = self.app.emit("log", LogEvent { line });
        self.log.line(line);
    }
}

/// Clears the busy flag when an operation ends, however it ends.
struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn parse_branches(list: &[String]) -> Result<Vec<Branch>, Failure> {
    list.iter()
        .map(|s| {
            Branch::parse(s).ok_or_else(|| {
                Failure::early(OpError::new(
                    FailCode::Invalid,
                    "That Discord isn't one I know.",
                    format!("unknown branch {s:?}"),
                ))
            })
        })
        .collect()
}

fn busy_failure() -> Failure {
    Failure::early(OpError::new(
        FailCode::Running,
        "Hang on, the installer is already working.",
        "another operation is running",
    ))
}

fn internal(e: impl std::fmt::Display) -> Failure {
    Failure::early(OpError::new(FailCode::Internal, "Something went wrong inside the installer.", e.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: &'static str,
    sandbox: Option<String>,
    log_path: Option<String>,
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        sandbox: state.env.sandbox.as_ref().map(|p| p.to_string_lossy().to_string()),
        log_path: state.log.path.as_ref().map(|p| p.to_string_lossy().to_string()),
    }
}

#[tauri::command]
async fn detect(state: State<'_, AppState>) -> Result<Detection, String> {
    let env = state.env.clone();
    let d = tauri::async_runtime::spawn_blocking(move || detect::detect(&env)).await.map_err(|e| e.to_string())?;
    state.log.line(&format!(
        "detect(): {} install(s) [{}], network {}, latest {}, installed build {}",
        d.installs.len(),
        d.installs
            .iter()
            .map(|i| format!("{} {} {:?}{}", i.branch, i.version, i.state, if i.running { " running" } else { "" }))
            .collect::<Vec<_>>()
            .join("; "),
        d.network,
        d.latest.as_ref().map(|l| l.title.as_str()).unwrap_or("none"),
        d.installed_build.as_ref().and_then(|b| b.get("hash")).and_then(|h| h.as_str()).unwrap_or("none"),
    ));
    Ok(d)
}

#[tauri::command]
async fn install(
    app: AppHandle,
    state: State<'_, AppState>,
    branches: Vec<String>,
    replace_custom: Option<Vec<String>>,
    force: Option<bool>,
) -> Result<Summary, Failure> {
    let req = InstallRequest {
        branches: parse_branches(&branches)?,
        replace_custom: parse_branches(&replace_custom.unwrap_or_default())?,
        force: force.unwrap_or(false),
    };
    if state.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err(busy_failure());
    }
    let _guard = BusyGuard(&state.busy);
    let env = state.env.clone();
    let rep = TauriReporter { app, log: state.log.clone() };
    state
        .log
        .line(&format!("install({:?}, replaceCustom {:?}, force {})", req.branches, req.replace_custom, req.force));
    let result =
        tauri::async_runtime::spawn_blocking(move || ops::install(&env, &req, &rep)).await.map_err(internal)?;
    if let Err(f) = &result {
        state.log.line(&format!("install failed: {:?} {} ({})", f.code, f.message, f.detail));
    }
    result
}

#[tauri::command]
async fn uninstall(
    app: AppHandle,
    state: State<'_, AppState>,
    branches: Vec<String>,
    keep_vencord: bool,
) -> Result<Summary, Failure> {
    let req = UninstallRequest { branches: parse_branches(&branches)?, keep_vencord };
    if state.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err(busy_failure());
    }
    let _guard = BusyGuard(&state.busy);
    let env = state.env.clone();
    let rep = TauriReporter { app, log: state.log.clone() };
    state.log.line(&format!("uninstall({:?}, keepVencord {})", req.branches, req.keep_vencord));
    let result =
        tauri::async_runtime::spawn_blocking(move || ops::uninstall(&env, &req, &rep)).await.map_err(internal)?;
    if let Err(f) = &result {
        state.log.line(&format!("uninstall failed: {:?} {} ({})", f.code, f.message, f.detail));
    }
    result
}

/// Links the UI may open. Anything else is refused.
pub fn url_allowed(url: &str) -> bool {
    if url.len() > 512
        || url.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '\'' | '<' | '>' | '`' | '\\'))
    {
        return false;
    }
    let prefixed =
        |base: &str| url == base || url.strip_prefix(base).is_some_and(|rest| rest.starts_with(['/', '?', '#']));
    prefixed("https://github.com/codemaker66/discord-stuff")
        || prefixed("https://codemaker66.github.io/discord-stuff")
        || prefixed("https://discord.com/download")
}

#[tauri::command]
fn open_url(state: State<'_, AppState>, url: String) -> Result<(), String> {
    if !url_allowed(&url) {
        state.log.line(&format!("open_url refused: {url}"));
        return Err("That link isn't allowed.".into());
    }
    state.log.line(&format!("open_url: {url}"));
    shell_open(&url)
}

#[cfg(windows)]
fn shell_open(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (verb, target) = (wide("open"), wide(url));
    // SAFETY: both strings are NUL-terminated UTF-16 buffers that outlive the call.
    let r = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if (r as isize) > 32 {
        Ok(())
    } else {
        Err(format!("Windows couldn't open the link (code {})", r as isize))
    }
}

#[cfg(not(windows))]
fn shell_open(_url: &str) -> Result<(), String> {
    Err("not supported on this platform".into())
}

#[tauri::command]
fn launch_discord(state: State<'_, AppState>, branch: String) -> Result<(), String> {
    let b = Branch::parse(&branch).ok_or("Unknown Discord")?;
    let info = detect::scan_branch(&state.env, b).ok_or_else(|| format!("{} isn't installed", b.label()))?;
    let log = state.log.clone();
    core::procs::start(&state.env, b, std::path::Path::new(&info.dir), &|l| log.line(l))
}

pub fn run() {
    let env = match Env::from_process() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("Dopa's Discord Purifier Setup cannot start: {e}");
            std::process::exit(1);
        }
    };
    let log = Arc::new(FileLog::open(&env));
    log.line(&format!(
        "Dopa's Discord Purifier Setup {} starting{}",
        env!("CARGO_PKG_VERSION"),
        env.sandbox.as_ref().map(|s| format!(" in sandbox {}", s.display())).unwrap_or_default()
    ));
    if let Some(lb) = &env.local_build {
        log.line(&format!("Local build: {}", lb.display()));
    }
    // WebView2 keeps its profile next to our cache and logs (or in the sandbox),
    // not in a folder of its own under %LOCALAPPDATA%.
    let webview_dir = env.data_dir().join("webview");
    let state = AppState { env: Arc::new(env), busy: AtomicBool::new(false), log: log.clone() };
    let setup_log = log.clone();
    let result = tauri::Builder::default()
        .manage(state)
        .setup(move |app| {
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .ok_or("tauri.conf.json has no main window")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .data_directory(webview_dir.clone())
                .build()?;
            setup_log.line(&format!("Window created (WebView2 data in {})", webview_dir.display()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_info, detect, install, uninstall, open_url, launch_discord])
        .run(tauri::generate_context!());
    if let Err(e) = result {
        log.line(&format!("Tauri failed: {e}"));
        eprintln!("Dopa's Discord Purifier Setup failed: {e}");
        std::process::exit(1);
    }
}
