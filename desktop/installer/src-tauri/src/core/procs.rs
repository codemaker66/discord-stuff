//! Finding, closing and starting Discord. In a sandbox every one of these is a
//! logged no-op, so tests can never touch a real Discord process.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::branch::Branch;
use super::env::Env;

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// Lists the image names of every running process (Toolhelp snapshot).
#[cfg(windows)]
pub fn process_names() -> Vec<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut names = Vec::new();
    // SAFETY: plain Win32 calls; the entry struct is sized before use and the
    // snapshot handle is closed on every path.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return names;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut entry);
        while ok != 0 {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            names.push(String::from_utf16_lossy(&entry.szExeFile[..len]));
            ok = Process32NextW(snap, &mut entry);
        }
        CloseHandle(snap);
    }
    names
}

#[cfg(not(windows))]
pub fn process_names() -> Vec<String> {
    Vec::new()
}

fn exe_running(names: &[String], exe: &str) -> bool {
    names.iter().any(|n| n.eq_ignore_ascii_case(exe))
}

/// Whether the branch's Discord is running (in a sandbox: DOPA_SANDBOX_RUNNING).
pub fn is_running(env: &Env, branch: Branch) -> bool {
    if env.is_sandbox() {
        return env.sandbox_running.contains(&branch);
    }
    exe_running(&process_names(), branch.exe())
}

/// Closes the branch's Discord (`taskkill /F /IM <exe> /T`) and waits until it
/// is gone, so its files are free. Returns whether it was running.
pub fn close(env: &Env, branch: Branch, log: &dyn Fn(&str)) -> Result<bool, String> {
    if env.is_sandbox() {
        let was = env.sandbox_running.contains(&branch);
        log(&format!(
            "[sandbox] would close {} ({}): {}",
            branch.label(),
            branch.exe(),
            if was { "marked running" } else { "not running" }
        ));
        return Ok(was);
    }
    if !exe_running(&process_names(), branch.exe()) {
        return Ok(false);
    }
    log(&format!("Closing {} ({})", branch.label(), branch.exe()));
    let mut cmd = Command::new("taskkill");
    cmd.args(["/F", "/IM", branch.exe(), "/T"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let _ = cmd.status();
    let deadline = Instant::now() + Duration::from_secs(15);
    while exe_running(&process_names(), branch.exe()) {
        if Instant::now() > deadline {
            return Err(format!("{} did not close", branch.label()));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    // Give Windows a moment to release the file handles.
    std::thread::sleep(Duration::from_millis(600));
    Ok(true)
}

/// Starts Discord the way its shortcut does: `Update.exe --processStart <exe>`.
pub fn start(env: &Env, branch: Branch, install_dir: &Path, log: &dyn Fn(&str)) -> Result<(), String> {
    let update = install_dir.join("Update.exe");
    if env.is_sandbox() {
        log(&format!(
            "[sandbox] would start {}: \"{}\" --processStart {}",
            branch.label(),
            update.display(),
            branch.exe()
        ));
        return Ok(());
    }
    if !update.is_file() {
        return Err(format!("{} is missing", update.display()));
    }
    log(&format!("Starting {}", branch.label()));
    let mut cmd = Command::new(&update);
    cmd.args(["--processStart", branch.exe()])
        .current_dir(install_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(DETACHED_PROCESS);
    cmd.spawn().map(|_| ()).map_err(|e| format!("could not start {}: {e}", branch.label()))
}
