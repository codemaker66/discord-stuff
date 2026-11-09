//! Where things live, and the test hooks that move them.
//!
//! * `DOPA_SANDBOX=<dir>`: %LOCALAPPDATA% becomes `<dir>\Local` and %APPDATA%
//!   becomes `<dir>\Roaming`; killing and starting Discord become logged
//!   no-ops, and the Vencord CLI is pointed at the sandbox in a way that keeps
//!   it away from real Discord processes (see `cli.rs`).
//! * `DOPA_LOCAL_BUILD=<dir>`: the Vencord files, SHA256SUMS.txt and
//!   build.json come from this folder instead of the latest GitHub release.
//! * `DOPA_SANDBOX_RUNNING=stable,ptb`: in a sandbox, which branches count as
//!   running (so the close/restart logic can be exercised).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::branch::Branch;
use super::net::{Fetcher, HttpFetcher};

pub const REPO: &str = "codemaker66/discord-stuff";
pub const API_BASE: &str = "https://api.github.com";
/// The marker the installer writes into %APPDATA%\Vencord\dist\build.json.
pub const OUR_MARK: &str = "dopas-purifier";

pub struct Env {
    /// %LOCALAPPDATA% (or `<sandbox>\Local`).
    pub local: PathBuf,
    /// %APPDATA% (or `<sandbox>\Roaming`).
    pub roaming: PathBuf,
    pub sandbox: Option<PathBuf>,
    pub local_build: Option<PathBuf>,
    pub sandbox_running: Vec<Branch>,
    pub net: Arc<dyn Fetcher>,
    pub api_base: String,
    pub repo: String,
}

fn absolute(p: impl AsRef<Path>) -> PathBuf {
    let p = p.as_ref();
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}

fn non_empty(v: Option<OsString>) -> Option<OsString> {
    v.filter(|s| !s.is_empty())
}

impl Env {
    /// Reads the real process environment.
    pub fn from_process() -> Result<Env, String> {
        Self::from_lookup(|k| std::env::var_os(k), Arc::new(HttpFetcher::new()))
    }

    /// Builds an Env from any variable lookup (tests pass a closure over a map).
    pub fn from_lookup(get: impl Fn(&str) -> Option<OsString>, net: Arc<dyn Fetcher>) -> Result<Env, String> {
        let local_build = non_empty(get("DOPA_LOCAL_BUILD")).map(absolute);
        if let Some(sb) = non_empty(get("DOPA_SANDBOX")) {
            let mut env = Env::sandboxed(absolute(sb), local_build, net);
            if let Some(list) = get("DOPA_SANDBOX_RUNNING") {
                env.sandbox_running = list.to_string_lossy().split(',').filter_map(Branch::parse).collect();
            }
            return Ok(env);
        }
        let local = non_empty(get("LOCALAPPDATA")).ok_or("%LOCALAPPDATA% is not set")?;
        let roaming = non_empty(get("APPDATA")).ok_or("%APPDATA% is not set")?;
        Ok(Env {
            local: absolute(local),
            roaming: absolute(roaming),
            sandbox: None,
            local_build,
            sandbox_running: Vec::new(),
            net,
            api_base: API_BASE.to_string(),
            repo: REPO.to_string(),
        })
    }

    /// An Env rooted in a sandbox folder (`<dir>\Local`, `<dir>\Roaming`).
    pub fn sandboxed(dir: PathBuf, local_build: Option<PathBuf>, net: Arc<dyn Fetcher>) -> Env {
        let dir = absolute(dir);
        Env {
            local: dir.join("Local"),
            roaming: dir.join("Roaming"),
            sandbox: Some(dir),
            local_build,
            sandbox_running: Vec::new(),
            net,
            api_base: API_BASE.to_string(),
            repo: REPO.to_string(),
        }
    }

    pub fn is_sandbox(&self) -> bool {
        self.sandbox.is_some()
    }

    /// Vencord's base dir, passed to the CLI as VENCORD_USER_DATA_DIR.
    pub fn vencord_base(&self) -> PathBuf {
        self.roaming.join("Vencord")
    }

    /// Where the Vencord files live: %APPDATA%\Vencord\dist.
    pub fn dist(&self) -> PathBuf {
        self.vencord_base().join("dist")
    }

    /// The patcher our stubs require.
    pub fn our_patcher(&self) -> PathBuf {
        self.dist().join("patcher.js")
    }

    /// %LOCALAPPDATA%\DopasPurifier: the installer's own cache and logs.
    pub fn data_dir(&self) -> PathBuf {
        self.local.join("DopasPurifier")
    }

    pub fn cache_dir(&self) -> PathBuf {
        self.data_dir().join("cache")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir().join("logs")
    }

    pub fn discord_dir(&self, branch: Branch) -> PathBuf {
        self.local.join(branch.dir_name())
    }

    pub fn latest_release_url(&self) -> String {
        format!("{}/repos/{}/releases/latest", self.api_base, self.repo)
    }
}

/// Compares Windows paths the way the file system does: case-insensitive,
/// either slash, no trailing separator, no `.` segments.
pub fn same_path(a: &str, b: &str) -> bool {
    normalize(a) == normalize(b)
}

pub fn normalize(p: &str) -> String {
    let p = p.trim().replace('/', "\\");
    let p = p.strip_prefix("\\\\?\\").unwrap_or(&p);
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('\\') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("\\").to_lowercase()
}
