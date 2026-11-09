//! Putting a verified build into %APPDATA%\Vencord\dist, backing up whatever
//! was there first when it is not ours.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};
use serde_json::Value;

use super::detect;
use super::env::{Env, OUR_MARK};
use super::error::OpError;
use super::fetch::{is_vencord_file, BuildFiles, BUILD_JSON};

pub const BACKUP_PREFIX: &str = "dist-backup-";

#[derive(Debug, Clone)]
pub struct PlaceOutcome {
    /// Where an earlier, not-ours dist was moved.
    pub backup: Option<PathBuf>,
    /// The build.json written (release build.json plus "by").
    pub build: Value,
}

/// `dist-backup-20261109-094300`
pub fn backup_name(now: &DateTime<Local>) -> String {
    format!("{BACKUP_PREFIX}{}", now.format("%Y%m%d-%H%M%S"))
}

/// Backups of dist, newest first (names sort by time).
pub fn list_backups(env: &Env) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(env.vencord_base()) else { return Vec::new() };
    let mut v: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(BACKUP_PREFIX) && e.path().is_dir())
        .map(|e| e.path())
        .collect();
    v.sort();
    v.reverse();
    v
}

fn dir_has_entries(dir: &Path) -> bool {
    fs::read_dir(dir).map(|mut r| r.next().is_some()).unwrap_or(false)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let t = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &t)?;
        } else {
            fs::copy(e.path(), t)?;
        }
    }
    Ok(())
}

/// Writes `bytes` to `path` through a temp file and a rename, so a reader
/// never sees half a file.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("dopa-tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

/// Moves a dist that is not ours aside, then writes the build, `package.json`
/// (`{}`; it stops Node from walking up to a stray package.json, which the
/// CLI skips in dev-install mode) and our build.json.
pub fn place(env: &Env, build: &BuildFiles, now: DateTime<Local>, log: &dyn Fn(&str)) -> Result<PlaceOutcome, OpError> {
    let dist = env.dist();
    let base = env.vencord_base();
    fs::create_dir_all(&base).map_err(|e| OpError::io("create Vencord folder", e))?;
    let was_ours = detect::installed_build(env).is_some();
    let mut backup = None;
    if dist.exists() && !was_ours && dir_has_entries(&dist) {
        let mut target = base.join(backup_name(&now));
        let mut n = 2;
        while target.exists() {
            target = base.join(format!("{}-{n}", backup_name(&now)));
            n += 1;
        }
        match fs::rename(&dist, &target) {
            Ok(()) => log(&format!("Backed up the previous Vencord files to {}", target.display())),
            Err(e) => {
                log(&format!("Could not move the old files ({e}); copying them instead"));
                copy_dir(&dist, &target).map_err(|e| OpError::io("back up old Vencord files", e))?;
                log(&format!("Copied the previous Vencord files to {}", target.display()));
            }
        }
        backup = Some(target);
    }
    fs::create_dir_all(&dist).map_err(|e| OpError::io("create dist folder", e))?;
    for name in &build.files {
        let bytes = fs::read(build.dir.join(name)).map_err(|e| OpError::io(&format!("read {name}"), e))?;
        write_atomic(&dist.join(name), &bytes).map_err(|e| OpError::io(&format!("write {name}"), e))?;
    }
    // Drop Vencord files an older build of ours had that this one does not.
    if was_ours {
        if let Ok(rd) = fs::read_dir(&dist) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if is_vencord_file(&n) && !build.files.contains(&n) && e.path().is_file() {
                    let _ = fs::remove_file(e.path());
                    log(&format!("Removed old file {n}"));
                }
            }
        }
    }
    write_atomic(&dist.join("package.json"), b"{}").map_err(|e| OpError::io("write package.json", e))?;
    let mut marked = build.build.clone();
    if let Value::Object(map) = &mut marked {
        map.insert("by".into(), Value::String(OUR_MARK.into()));
        map.insert("installedAt".into(), Value::String(now.to_rfc3339()));
    }
    let text = serde_json::to_string_pretty(&marked).unwrap_or_else(|_| "{}".into()) + "\n";
    write_atomic(&dist.join(BUILD_JSON), text.as_bytes()).map_err(|e| OpError::io("write build.json", e))?;
    log(&format!("Placed {} files in {}", build.files.len() + 2, dist.display()));
    Ok(PlaceOutcome { backup, build: marked })
}

/// After an uninstall that leaves nothing using dist: removes our files and
/// restores the newest backup when there is one. Returns what happened.
pub fn remove_ours(env: &Env, log: &dyn Fn(&str)) -> Result<Option<PathBuf>, OpError> {
    let dist = env.dist();
    if detect::installed_build(env).is_none() {
        log("The Vencord folder does not hold our build; leaving it alone");
        return Ok(None);
    }
    fs::remove_dir_all(&dist).map_err(|e| OpError::io("remove the Purifier files", e))?;
    log(&format!("Removed {}", dist.display()));
    if let Some(b) = list_backups(env).into_iter().next() {
        fs::rename(&b, &dist).map_err(|e| OpError::io("restore the old Vencord files", e))?;
        log(&format!("Restored {} to {}", b.display(), dist.display()));
        return Ok(Some(b));
    }
    Ok(None)
}
