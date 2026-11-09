//! The install and uninstall flows, step by step.

use std::path::PathBuf;

use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::branch::Branch;
use super::cli::{self, CliAction};
use super::detect::{self, InstallInfo, State};
use super::env::{same_path, Env};
use super::error::{FailCode, OpError};
use super::fetch::{self, CLI_PIN};
use super::place;
use super::procs;
use super::report::{Reporter, Tracker};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub branches: Vec<Branch>,
    /// "custom"/"unknown" installs (someone's own Vencord) are only replaced
    /// when listed here.
    #[serde(default)]
    pub replace_custom: Vec<Branch>,
    /// Re-patch installs that are already ours (Repair).
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallRequest {
    pub branches: Vec<Branch>,
    /// Re-patch with official Vencord instead of removing Vencord.
    #[serde(default)]
    pub keep_vencord: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchResult {
    pub branch: Branch,
    pub label: String,
    /// "patched", "already", "kept-custom", "vencord", "restored"
    pub result: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// "install" or "uninstall"
    pub action: String,
    pub branches: Vec<BranchResult>,
    /// Branches started at the end.
    pub started: Vec<Branch>,
    /// Where a previous %APPDATA%\Vencord\dist was backed up (install).
    pub backup: Option<String>,
    /// Which backup was put back (uninstall).
    pub restored: Option<String>,
    /// Our build.json as written (install).
    pub build: Option<Value>,
    pub log: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: FailCode,
    /// One friendly sentence for the UI.
    pub message: String,
    /// The technical reason.
    pub detail: String,
    /// The step that failed, when one had started.
    pub step: Option<String>,
    /// The whole log, for "Copy log".
    pub log: String,
}

impl Failure {
    pub fn early(e: OpError) -> Self {
        Failure { code: e.code, message: e.message, detail: e.detail, step: None, log: String::new() }
    }
}

type StepErr = (String, OpError);

fn at(step: &str) -> impl Fn(OpError) -> StepErr + '_ {
    move |e| (step.to_string(), e)
}

/// Resolves the requested branches to detected installs.
fn select(installs: &[InstallInfo], wanted: &[Branch]) -> Result<Vec<InstallInfo>, OpError> {
    if installs.is_empty() {
        return Err(OpError::new(
            FailCode::NoDiscord,
            "Discord isn't installed on this PC yet. Install it, open it once, then run this again.",
            "no Discord, DiscordPTB or DiscordCanary folder with an app-* version under %LOCALAPPDATA%",
        ));
    }
    let mut out: Vec<InstallInfo> = Vec::new();
    for b in wanted {
        if out.iter().any(|i| i.branch == *b) {
            continue;
        }
        match installs.iter().find(|i| i.branch == *b) {
            Some(i) => out.push(i.clone()),
            None => {
                return Err(OpError::new(
                    FailCode::Invalid,
                    format!("{} isn't installed.", b.label()),
                    format!("no install for {b}"),
                ));
            }
        }
    }
    if out.is_empty() {
        return Err(OpError::new(FailCode::Invalid, "Pick at least one Discord first.", "no branches selected"));
    }
    out.sort_by_key(|i| i.branch);
    Ok(out)
}

fn close_all(env: &Env, t: &Tracker, targets: &[InstallInfo], closed: &mut Vec<Branch>) -> Result<(), StepErr> {
    t.active("close", "Closing Discord");
    let log = |l: &str| t.log(l);
    for i in targets {
        match procs::close(env, i.branch, &log) {
            Ok(true) => closed.push(i.branch),
            Ok(false) => {}
            Err(msg) => {
                return Err(at("close")(OpError::new(
                    FailCode::Busy,
                    format!("Couldn't close {}. Quit it from the system tray and try again.", i.label),
                    msg,
                )))
            }
        }
    }
    let detail = if closed.is_empty() {
        "Discord wasn't running".to_string()
    } else {
        format!("Closed {}", closed.iter().map(|b| b.label()).collect::<Vec<_>>().join(" and "))
    };
    t.done("close", &detail);
    Ok(())
}

fn get_cli(env: &Env, t: &Tracker) -> Result<PathBuf, StepErr> {
    t.active("fetch-installer", "Getting Vencord's official installer");
    let log = |l: &str| t.log(l);
    let path = fetch::ensure_cli(
        env,
        &CLI_PIN,
        &mut |f| t.partial("fetch-installer", f, "Downloading Vencord's installer"),
        &log,
    )
    .map_err(at("fetch-installer"))?;
    t.done("fetch-installer", &format!("Vencord Installer {}, verified", CLI_PIN.version));
    Ok(path)
}

/// Starts what was running before, or one Discord when nothing was.
fn start_after(env: &Env, t: &Tracker, targets: &[InstallInfo], closed: &[Branch]) -> Vec<Branch> {
    t.active("start", "Starting Discord");
    let log = |l: &str| t.log(l);
    let mut which: Vec<&InstallInfo> = targets.iter().filter(|i| closed.contains(&i.branch)).collect();
    if which.is_empty() {
        if let Some(i) = targets.iter().find(|i| i.branch == Branch::Stable).or_else(|| targets.first()) {
            which.push(i);
        }
    }
    let mut started = Vec::new();
    let mut failed = Vec::new();
    for i in which {
        match procs::start(env, i.branch, std::path::Path::new(&i.dir), &log) {
            Ok(()) => started.push(i.branch),
            Err(e) => {
                t.log(&format!("Couldn't start {}: {e}", i.label));
                failed.push(i.label.clone());
            }
        }
    }
    let detail = if failed.is_empty() {
        format!("Started {}", started.iter().map(|b| b.label()).collect::<Vec<_>>().join(" and "))
    } else {
        format!("Open {} yourself", failed.join(" and "))
    };
    t.done("start", &detail);
    started
}

/// After a failure: bring back what we closed, best effort.
fn restart_closed(env: &Env, t: &Tracker, targets: &[InstallInfo], closed: &[Branch]) {
    let log = |l: &str| t.log(l);
    for i in targets.iter().filter(|i| closed.contains(&i.branch)) {
        if let Err(e) = procs::start(env, i.branch, std::path::Path::new(&i.dir), &log) {
            t.log(&format!("Couldn't restart {}: {e}", i.label));
        }
    }
}

fn header(t: &Tracker, env: &Env, what: &str) {
    t.log(&format!(
        "Dopa's Discord Purifier Setup {} · {} · {}",
        env!("CARGO_PKG_VERSION"),
        what,
        Local::now().format("%Y-%m-%d %H:%M:%S")
    ));
    if let Some(sb) = &env.sandbox {
        t.log(&format!("Sandbox: {}", sb.display()));
    }
}

pub fn install(env: &Env, req: &InstallRequest, rep: &dyn Reporter) -> Result<Summary, Failure> {
    let installs = detect::scan(env);
    let targets = select(&installs, &req.branches).map_err(Failure::early)?;
    let share = 40.0 / targets.len() as f64;
    let mut plan: Vec<(String, String, f64)> = vec![
        ("close".into(), "Close Discord".into(), 4.0),
        ("fetch-installer".into(), "Get Vencord's installer".into(), 16.0),
        ("fetch-build".into(), "Download the Purifier build".into(), 24.0),
        ("place".into(), "Put the files in place".into(), 8.0),
    ];
    for i in &targets {
        plan.push((format!("patch:{}", i.branch), format!("Patch {}", i.label), share));
    }
    plan.push(("start".into(), "Start Discord".into(), 8.0));
    let t = Tracker::new(rep, plan);
    header(&t, env, "install");
    for i in &targets {
        t.log(&format!("{} {} at {}: {:?}", i.label, i.version, i.dir, i.state));
    }
    let mut closed = Vec::new();
    match install_steps(env, req, &t, &targets, &mut closed) {
        Ok(mut s) => {
            t.log("Install finished");
            s.log = t.full_log();
            Ok(s)
        }
        Err((step, e)) => {
            t.error(&step, &e.message);
            t.log(&format!("FAILED at {step}: {}", e.detail));
            restart_closed(env, &t, &targets, &closed);
            Err(Failure { code: e.code, message: e.message, detail: e.detail, step: Some(step), log: t.full_log() })
        }
    }
}

fn install_steps(
    env: &Env,
    req: &InstallRequest,
    t: &Tracker,
    targets: &[InstallInfo],
    closed: &mut Vec<Branch>,
) -> Result<Summary, StepErr> {
    let log = |l: &str| t.log(l);
    close_all(env, t, targets, closed)?;
    let cli_path = get_cli(env, t)?;

    t.active("fetch-build", "Downloading the Purifier build");
    let build =
        fetch::fetch_build(env, &mut |f, name| t.partial("fetch-build", f, name), &log).map_err(at("fetch-build"))?;
    t.done("fetch-build", &format!("{} files verified", build.files.len() + 1));

    t.active("place", "Putting the files in place");
    let placed = place::place(env, &build, Local::now(), &log).map_err(at("place"))?;
    let place_detail = match &placed.backup {
        Some(b) => format!(
            "Saved your old Vencord files to {}",
            b.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
        ),
        None => "Files in place".to_string(),
    };
    t.done("place", &place_detail);

    let our = env.our_patcher().to_string_lossy().to_string();
    let mut results = Vec::new();
    for before in targets {
        let id = format!("patch:{}", before.branch);
        t.active(&id, &format!("Patching {}", before.label));
        let now = detect::scan_branch(env, before.branch).ok_or_else(|| {
            at(&id)(OpError::new(
                FailCode::NoDiscord,
                format!("{} disappeared during the install.", before.label),
                "install folder is gone",
            ))
        })?;
        let linked = now.patcher.as_deref().is_some_and(|p| same_path(p, &our)) && now.original_asar;
        if linked && !req.force {
            let detail = if before.state == State::Vencord {
                "Already linked to Vencord; it now loads the Purifier build".to_string()
            } else {
                "Already set up".to_string()
            };
            t.log(&format!("{}: {detail}", before.label));
            t.skipped(&id, &detail);
            results.push(BranchResult {
                branch: before.branch,
                label: before.label.clone(),
                result: "already".into(),
                detail,
            });
            continue;
        }
        if matches!(now.state, State::Custom | State::Unknown) && !req.replace_custom.contains(&before.branch) {
            let detail = format!(
                "Kept your own Vencord build ({})",
                now.patcher.clone().unwrap_or_else(|| "unrecognised app.asar".into())
            );
            t.log(&format!("{}: {detail}", before.label));
            t.skipped(&id, "Kept your own Vencord build");
            results.push(BranchResult {
                branch: before.branch,
                label: before.label.clone(),
                result: "kept-custom".into(),
                detail,
            });
            continue;
        }
        cli::run(env, &cli_path, CliAction::InstallOurs, before.branch, std::path::Path::new(&now.dir), &log)
            .map_err(at(&id))?;
        let after = detect::scan_branch(env, before.branch);
        let ok = after.as_ref().is_some_and(|a| {
            a.state == State::Ours && a.original_asar && a.patcher.as_deref().is_some_and(|p| same_path(p, &our))
        });
        if !ok {
            return Err(at(&id)(OpError::new(
                FailCode::Cli,
                format!("{} didn't end up patched. Copy the log if you want help.", before.label),
                format!("after the CLI: {:?}", after.map(|a| (a.state, a.patcher, a.original_asar))),
            )));
        }
        t.log(&format!("{}: app.asar now loads {our}", before.label));
        t.done(&id, &format!("{} patched", before.label));
        results.push(BranchResult {
            branch: before.branch,
            label: before.label.clone(),
            result: "patched".into(),
            detail: "Patched".into(),
        });
    }

    let started = start_after(env, t, targets, closed);
    Ok(Summary {
        action: "install".into(),
        branches: results,
        started,
        backup: placed.backup.map(|p| p.to_string_lossy().to_string()),
        restored: None,
        build: Some(placed.build),
        log: String::new(),
    })
}

pub fn uninstall(env: &Env, req: &UninstallRequest, rep: &dyn Reporter) -> Result<Summary, Failure> {
    let installs = detect::scan(env);
    let selected = select(&installs, &req.branches).map_err(Failure::early)?;
    let targets: Vec<InstallInfo> = selected.into_iter().filter(|i| i.state == State::Ours).collect();
    if targets.is_empty() {
        return Err(Failure::early(OpError::new(
            FailCode::Invalid,
            "The Purifier isn't installed in the Discord you picked.",
            "no selected install is in state ours",
        )));
    }
    let share = 50.0 / targets.len() as f64;
    let mut plan: Vec<(String, String, f64)> = vec![
        ("close".into(), "Close Discord".into(), 6.0),
        ("fetch-installer".into(), "Get Vencord's installer".into(), 20.0),
    ];
    for i in &targets {
        if req.keep_vencord {
            plan.push((format!("vencord:{}", i.branch), format!("Switch {} to official Vencord", i.label), share));
        } else {
            plan.push((format!("unpatch:{}", i.branch), format!("Restore {}", i.label), share));
        }
    }
    if req.keep_vencord {
        plan.push(("tidy".into(), "Tidy up".into(), 14.0));
    } else {
        plan.push(("restore".into(), "Remove the Purifier files".into(), 14.0));
    }
    plan.push(("start".into(), "Start Discord".into(), 10.0));
    let t = Tracker::new(rep, plan);
    header(&t, env, if req.keep_vencord { "uninstall, keeping Vencord" } else { "uninstall" });
    let mut closed = Vec::new();
    match uninstall_steps(env, req, &t, &targets, &mut closed) {
        Ok(mut s) => {
            t.log("Uninstall finished");
            s.log = t.full_log();
            Ok(s)
        }
        Err((step, e)) => {
            t.error(&step, &e.message);
            t.log(&format!("FAILED at {step}: {}", e.detail));
            restart_closed(env, &t, &targets, &closed);
            Err(Failure { code: e.code, message: e.message, detail: e.detail, step: Some(step), log: t.full_log() })
        }
    }
}

fn uninstall_steps(
    env: &Env,
    req: &UninstallRequest,
    t: &Tracker,
    targets: &[InstallInfo],
    closed: &mut Vec<Branch>,
) -> Result<Summary, StepErr> {
    let log = |l: &str| t.log(l);
    close_all(env, t, targets, closed)?;
    let cli_path = get_cli(env, t)?;
    let our = env.our_patcher().to_string_lossy().to_string();
    let mut results = Vec::new();
    for i in targets {
        let dir = std::path::Path::new(&i.dir);
        if req.keep_vencord {
            let id = format!("vencord:{}", i.branch);
            t.active(&id, &format!("Installing official Vencord into {}", i.label));
            cli::run(env, &cli_path, CliAction::InstallOfficial, i.branch, dir, &log).map_err(at(&id))?;
            let after = detect::scan_branch(env, i.branch);
            let ok = after
                .as_ref()
                .is_some_and(|a| a.original_asar && a.patcher.as_deref().is_some_and(|p| same_path(p, &our)));
            if !ok {
                return Err(at(&id)(OpError::new(
                    FailCode::Cli,
                    format!("{} didn't end up on official Vencord. Copy the log if you want help.", i.label),
                    format!("after the CLI: {:?}", after.map(|a| (a.state, a.patcher, a.original_asar))),
                )));
            }
            t.done(&id, &format!("{} runs official Vencord", i.label));
            results.push(BranchResult {
                branch: i.branch,
                label: i.label.clone(),
                result: "vencord".into(),
                detail: "Official Vencord".into(),
            });
        } else {
            let id = format!("unpatch:{}", i.branch);
            t.active(&id, &format!("Restoring {}", i.label));
            cli::run(env, &cli_path, CliAction::Uninstall, i.branch, dir, &log).map_err(at(&id))?;
            let after = detect::scan_branch(env, i.branch);
            let ok = after.as_ref().is_some_and(|a| a.state == State::Clean && !a.original_asar);
            if !ok {
                return Err(at(&id)(OpError::new(
                    FailCode::Cli,
                    format!("{} wasn't fully restored. Copy the log if you want help.", i.label),
                    format!("after the CLI: {:?}", after.map(|a| (a.state, a.patcher, a.original_asar))),
                )));
            }
            t.done(&id, &format!("{} is back to normal", i.label));
            results.push(BranchResult {
                branch: i.branch,
                label: i.label.clone(),
                result: "restored".into(),
                detail: "Discord's own files are back".into(),
            });
        }
    }

    let mut restored = None;
    if req.keep_vencord {
        t.active("tidy", "Tidying up");
        // The CLI replaced our files with official ones; drop our marker so
        // the installs read as official Vencord from now on.
        let marker = env.dist().join(fetch::BUILD_JSON);
        if marker.is_file() {
            std::fs::remove_file(&marker).map_err(|e| at("tidy")(OpError::io("remove build.json", e)))?;
            t.log(&format!("Removed {}", marker.display()));
        }
        t.done("tidy", "Vencord stays, the Purifier is gone");
    } else {
        t.active("restore", "Removing the Purifier files");
        let users: Vec<String> = detect::scan(env)
            .into_iter()
            .filter(|i| i.patcher.as_deref().is_some_and(|p| same_path(p, &our)))
            .map(|i| i.label)
            .collect();
        if users.is_empty() {
            let r = place::remove_ours(env, &log).map_err(at("restore"))?;
            let detail = match &r {
                Some(_) => "Removed, and put your previous Vencord files back",
                None => "Removed",
            };
            restored = r.map(|p| p.to_string_lossy().to_string());
            t.done("restore", detail);
        } else {
            let detail = format!("Kept: {} still uses them", users.join(" and "));
            t.log(&detail);
            t.skipped("restore", &detail);
        }
    }

    let started = start_after(env, t, targets, closed);
    Ok(Summary {
        action: "uninstall".into(),
        branches: results,
        started,
        backup: None,
        restored,
        build: None,
        log: String::new(),
    })
}
