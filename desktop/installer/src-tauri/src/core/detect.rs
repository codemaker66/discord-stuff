//! Finding Discord installs and telling what state each one is in.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use super::asar;
use super::branch::Branch;
use super::env::{same_path, Env, OUR_MARK};
use super::fetch;
use super::procs;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    /// Discord's own app.asar, no `_app.asar`.
    Clean,
    /// A stub requiring %APPDATA%\Vencord\dist\patcher.js, and build.json says
    /// `"by": "dopas-purifier"`.
    Ours,
    /// A stub requiring that same patcher without our build.json: official Vencord.
    Vencord,
    /// A stub requiring some other patcher.js (a developer's own Vencord build).
    Custom,
    /// Anything else: a stub that requires something unexpected, or a
    /// `_app.asar` next to an app.asar that is not a stub.
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallInfo {
    pub branch: Branch,
    pub label: String,
    pub exe: String,
    /// %LOCALAPPDATA%\Discord (the folder holding Update.exe and app-*).
    pub dir: String,
    /// The newest app-* folder.
    pub app_dir: String,
    /// "1.0.9267"
    pub version: String,
    pub running: bool,
    pub state: State,
    /// What the stub requires, when app.asar is a stub.
    pub patcher: Option<String>,
    /// Whether resources\_app.asar (Discord's original, moved aside) exists.
    pub original_asar: bool,
}

/// "app-1.0.9267" -> [1, 0, 9267]
pub fn app_version(name: &str) -> Option<Vec<u64>> {
    let v = name.strip_prefix("app-")?;
    let parts: Option<Vec<u64>> = v.split('.').map(|p| p.parse().ok()).collect();
    parts.filter(|p| !p.is_empty())
}

/// The newest `app-*` folder (by version number) that has a resources folder.
pub fn newest_app_dir(dir: &Path) -> Option<(PathBuf, String)> {
    let mut best: Option<(Vec<u64>, PathBuf, String)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(ver) = app_version(&name) else { continue };
        let path = entry.path();
        if !path.join("resources").is_dir() {
            continue;
        }
        if best.as_ref().is_none_or(|(b, _, _)| ver > *b) {
            let shown = name.trim_start_matches("app-").to_string();
            best = Some((ver, path, shown));
        }
    }
    best.map(|(_, p, s)| (p, s))
}

pub fn read_build_json(dist: &Path) -> Option<Value> {
    let text = fs::read_to_string(dist.join("build.json")).ok()?;
    serde_json::from_str::<Value>(&text).ok().filter(Value::is_object)
}

pub fn is_ours(build: &Value) -> bool {
    build.get("by").and_then(Value::as_str) == Some(OUR_MARK)
}

/// Our build.json, when %APPDATA%\Vencord\dist holds our build.
pub fn installed_build(env: &Env) -> Option<Value> {
    read_build_json(&env.dist()).filter(is_ours)
}

/// Classifies one `resources` folder.
pub fn classify(env: &Env, resources: &Path) -> (State, Option<String>, bool) {
    let app = resources.join("app.asar");
    let original = resources.join("_app.asar").is_file();
    let target = asar::read_stub(&app).ok().flatten();
    let state = match &target {
        Some(t) if same_path(t, &env.our_patcher().to_string_lossy()) => {
            if installed_build(env).is_some() {
                State::Ours
            } else {
                State::Vencord
            }
        }
        Some(t) if t.to_ascii_lowercase().replace('/', "\\").ends_with("\\patcher.js") => State::Custom,
        Some(_) => State::Unknown,
        None if !app.is_file() => State::Unknown,
        None if original => State::Unknown,
        None => State::Clean,
    };
    (state, target, original)
}

pub fn scan_branch(env: &Env, branch: Branch) -> Option<InstallInfo> {
    let dir = env.discord_dir(branch);
    let (app_dir, version) = newest_app_dir(&dir)?;
    let (state, patcher, original_asar) = classify(env, &app_dir.join("resources"));
    Some(InstallInfo {
        branch,
        label: branch.label().to_string(),
        exe: branch.exe().to_string(),
        dir: dir.to_string_lossy().to_string(),
        app_dir: app_dir.to_string_lossy().to_string(),
        version,
        running: procs::is_running(env, branch),
        state,
        patcher,
        original_asar,
    })
}

/// Every Discord install, Stable then PTB then Canary. No network.
pub fn scan(env: &Env) -> Vec<InstallInfo> {
    Branch::ALL.iter().filter_map(|b| scan_branch(env, *b)).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestRelease {
    /// The release title, e.g. "Dopa's Discord Purifier 4.2.0 for the Discord app · Vencord v1.14.1 · 94f9601".
    pub title: String,
    pub tag: Option<String>,
    /// The 7-char build hash (the last word of the title).
    pub hash: Option<String>,
    pub url: Option<String>,
    /// "github" or "local" (DOPA_LOCAL_BUILD).
    pub source: String,
    /// The local build.json (local source only).
    pub build: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub installs: Vec<InstallInfo>,
    /// %APPDATA%\Vencord
    pub vencord_dir: String,
    /// Our build.json from %APPDATA%\Vencord\dist, when installed.
    pub installed_build: Option<Value>,
    pub latest: Option<LatestRelease>,
    /// "ok", "offline", "no-release" or "local".
    pub network: String,
    /// Backups of a previous %APPDATA%\Vencord\dist, newest first.
    pub backups: Vec<String>,
    pub sandbox: bool,
    pub installer_version: String,
}

/// The latest release, best effort: (release, network status).
pub fn latest(env: &Env) -> (Option<LatestRelease>, String) {
    if let Some(dir) = &env.local_build {
        let build = read_build_json(dir);
        let hash = build.as_ref().and_then(|b| b.get("hash")).and_then(Value::as_str).map(String::from);
        let title = match (&build, &hash) {
            (Some(b), Some(h)) => format!(
                "Local build {} · Vencord {} · {}",
                b.get("purifier").and_then(Value::as_str).unwrap_or("?"),
                b.get("vencord").and_then(Value::as_str).unwrap_or("?"),
                h
            ),
            _ => "Local build".to_string(),
        };
        return (
            Some(LatestRelease { title, tag: None, hash, url: None, source: "local".into(), build }),
            "local".into(),
        );
    }
    match fetch::latest_release(env) {
        Ok(Some(r)) => {
            let title = r.title();
            (
                Some(LatestRelease {
                    hash: fetch::title_hash(&title),
                    title,
                    tag: Some(r.tag_name.clone()),
                    url: r.html_url.clone(),
                    source: "github".into(),
                    build: None,
                }),
                "ok".into(),
            )
        }
        Ok(None) => (None, "no-release".into()),
        Err(_) => (None, "offline".into()),
    }
}

pub fn detect(env: &Env) -> Detection {
    let (latest, network) = latest(env);
    Detection {
        installs: scan(env),
        vencord_dir: env.vencord_base().to_string_lossy().to_string(),
        installed_build: installed_build(env),
        latest,
        network,
        backups: super::place::list_backups(env).into_iter().map(|p| p.to_string_lossy().to_string()).collect(),
        sandbox: env.is_sandbox(),
        installer_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}
