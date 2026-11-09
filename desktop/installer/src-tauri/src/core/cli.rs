//! Running Vencord's official installer CLI (Vencord/Installer v1.4.2).
//!
//! What its source says (cli.go, patcher.go, github_downloader.go,
//! find_discord_windows.go, util.go at tag v1.4.2):
//!
//! * `-install` patches an install; when it is already patched (an
//!   `_app.asar` exists) it unpatches first and patches again. That is the
//!   flag for every case here, already-patched installs included.
//! * `-repair` always calls `installLatestBuilds()`, which ignores
//!   `VENCORD_DEV_INSTALL` and downloads official Vencord, so it is never used.
//! * With `VENCORD_DEV_INSTALL=1` the CLI skips GitHub entirely and uses the
//!   files already in `<VENCORD_USER_DATA_DIR>\dist` (and does not write
//!   dist\package.json). Without it, `-install` downloads official Vencord's
//!   latest release into dist whenever patcher.js's first line
//!   (`// Vencord <hash>`) differs from the latest hash.
//! * `-location <dir>` accepts any folder holding an `app-*` folder with a
//!   `resources` folder; the branch is guessed from the folder name's suffix
//!   (`canary`, `development`, `ptb`, else stable).
//! * Before patching, the CLI kills the first process named after that
//!   branch (Discord.exe for stable), whatever its path. In a sandbox the
//!   install is therefore reached through a junction whose name ends in
//!   "DiscordDevelopment": the CLI maps that branch to no process name, so it
//!   cannot kill a real Discord.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::branch::Branch;
use super::env::Env;
use super::error::{FailCode, OpError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliAction {
    /// `-install` with VENCORD_DEV_INSTALL=1: link Discord to the files we placed.
    InstallOurs,
    /// `-install` without it: the CLI downloads official Vencord into dist.
    InstallOfficial,
    /// `-uninstall`: put Discord's own app.asar back.
    Uninstall,
}

const TIMEOUT: Duration = Duration::from_secs(300);

/// Removes ANSI colour sequences (the CLI colours its level names on a TTY).
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for d in chars.by_ref() {
                    if d.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// The `-location` to hand the CLI. Real installs: the install folder itself.
/// Sandbox: a junction `<sandbox>\cli-view\<branch>\DiscordDevelopment`
/// pointing at the sandboxed install (see the module docs for why).
pub fn location_for(env: &Env, branch: Branch, install_dir: &Path) -> Result<PathBuf, OpError> {
    let Some(sb) = &env.sandbox else { return Ok(install_dir.to_path_buf()) };
    let parent = sb.join("cli-view").join(branch.id());
    std::fs::create_dir_all(&parent).map_err(|e| OpError::io("create sandbox view", e))?;
    let link = parent.join("DiscordDevelopment");
    if link.exists() || std::fs::symlink_metadata(&link).is_ok() {
        // remove_dir removes a junction itself and never its target's contents.
        std::fs::remove_dir(&link).map_err(|e| OpError::io("reset sandbox junction", e))?;
    }
    let mut cmd = Command::new("cmd");
    cmd.arg("/C").arg("mklink").arg("/J").arg(&link).arg(install_dir);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(super::procs::CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| OpError::io("create sandbox junction", e))?;
    if !out.status.success() || !link.is_dir() {
        return Err(OpError::io("create sandbox junction", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(link)
}

/// Runs the CLI for one install and streams its output to `log`.
pub fn run(
    env: &Env,
    cli: &Path,
    action: CliAction,
    branch: Branch,
    install_dir: &Path,
    log: &dyn Fn(&str),
) -> Result<(), OpError> {
    let location = location_for(env, branch, install_dir)?;
    let flag = match action {
        CliAction::InstallOurs | CliAction::InstallOfficial => "-install",
        CliAction::Uninstall => "-uninstall",
    };
    let mut cmd = Command::new(cli);
    cmd.arg(flag).arg("-location").arg(&location);
    cmd.env("VENCORD_USER_DATA_DIR", env.vencord_base());
    cmd.env_remove("DISCORD_USER_DATA_DIR");
    cmd.env("NO_COLOR", "1");
    if action == CliAction::InstallOurs {
        cmd.env("VENCORD_DEV_INSTALL", "1");
    } else {
        cmd.env_remove("VENCORD_DEV_INSTALL");
    }
    if env.is_sandbox() {
        cmd.env("LOCALAPPDATA", &env.local).env("APPDATA", &env.roaming);
    }
    cmd.current_dir(cli.parent().unwrap_or(Path::new(".")));
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(super::procs::CREATE_NO_WINDOW);

    log(&format!(
        "> VencordInstallerCli {flag} -location \"{}\"{}",
        location.display(),
        if action == CliAction::InstallOurs { "  (VENCORD_DEV_INSTALL=1)" } else { "" }
    ));
    let mut child = cmd.spawn().map_err(|e| {
        OpError::new(FailCode::Cli, "Couldn't start Vencord's installer.", format!("spawn {}: {e}", cli.display()))
    })?;

    let (tx, rx) = mpsc::channel::<String>();
    let mut readers = Vec::new();
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            let mut r = BufReader::new(stream);
            let mut buf = Vec::new();
            while let Ok(n) = r.read_until(b'\n', &mut buf) {
                if n == 0 {
                    break;
                }
                let line = strip_ansi(String::from_utf8_lossy(&buf).trim_end());
                if !line.is_empty() {
                    let _ = tx.send(line);
                }
                buf.clear();
            }
        }));
    }
    drop(tx);

    let started = Instant::now();
    let mut lines: Vec<String> = Vec::new();
    let status = loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                log(&format!("  {line}"));
                lines.push(line);
                continue;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            // Both pipes closed; the process is exiting.
            Err(mpsc::RecvTimeoutError::Disconnected) => std::thread::sleep(Duration::from_millis(50)),
        }
        if let Ok(Some(st)) = child.try_wait() {
            break st;
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(OpError::new(
                FailCode::Cli,
                "Vencord's installer stopped responding.",
                "timed out after 5 minutes",
            ));
        }
    };
    for r in readers {
        let _ = r.join();
    }
    for line in rx.try_iter() {
        log(&format!("  {line}"));
        lines.push(line);
    }

    if status.success() {
        return Ok(());
    }
    let errors: Vec<&String> = lines.iter().filter(|l| l.starts_with("ERROR") || l.starts_with("FATAL")).collect();
    let detail = format!(
        "VencordInstallerCli exited with {}{}",
        status.code().map(|c| c.to_string()).unwrap_or_else(|| "a signal".into()),
        if errors.is_empty() {
            String::new()
        } else {
            format!(": {}", errors.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" | "))
        }
    );
    if lines.iter().any(|l| l.contains("fetching release data failed")) {
        return Err(OpError::new(
            FailCode::Offline,
            "Vencord's installer couldn't reach GitHub. Check your internet connection and try again.",
            detail,
        ));
    }
    if lines.iter().any(|l| l.contains("used by a different process")) {
        return Err(OpError::new(
            FailCode::Busy,
            format!("{} is still using its files. Quit it from the system tray and try again.", branch.label()),
            detail,
        ));
    }
    Err(OpError::new(
        FailCode::Cli,
        format!("Vencord's installer couldn't update {}. It undoes its own half-finished changes; copy the log if you want help.", branch.label()),
        detail,
    ))
}
