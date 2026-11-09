//! Putting a verified build into %APPDATA%\Vencord\dist, backing up whatever
//! was there first when it is not ours.
//!
//! The build is written into a sibling folder (`dist.dopa-new`) first and then
//! swapped in with two renames, so a failure at any point (a full disk, an
//! antivirus holding a file) leaves dist exactly as it was and makes no backup.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Local};
use serde_json::Value;

use super::detect;
use super::env::{Env, OUR_MARK};
use super::error::OpError;
use super::fetch::{is_vencord_file, BuildFiles, BUILD_JSON};

pub const BACKUP_PREFIX: &str = "dist-backup-";
/// Where the new build is assembled before it is swapped in.
pub const STAGE_NAME: &str = "dist.dopa-new";
/// Where our own previous build (or an empty dist) waits during the swap.
pub const ASIDE_NAME: &str = "dist.dopa-old";

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

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
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

fn remove_any(p: &Path) -> io::Result<()> {
    if p.is_dir() {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    }
}

/// A rename that tries again for about a second and a half: right after
/// Discord quits, or while an antivirus scans new files, Windows can refuse
/// for a moment.
pub fn rename_retrying(from: &Path, to: &Path) -> io::Result<()> {
    let mut wait = 50;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if wait <= 800 && e.kind() != io::ErrorKind::NotFound => {
                std::thread::sleep(Duration::from_millis(wait));
                wait *= 2;
            }
            Err(e) => return Err(e),
        }
    }
}

type Rename<'a> = &'a dyn Fn(&Path, &Path) -> io::Result<()>;

/// Cleans up after a run that stopped half-way (a crash or a power cut):
/// a leftover staging folder goes, and our previous build comes back if it
/// was moved aside and nothing replaced it.
fn recover(base: &Path, dist: &Path, rename: Rename, log: &dyn Fn(&str)) -> Result<(), OpError> {
    let stage = base.join(STAGE_NAME);
    if fs::symlink_metadata(&stage).is_ok() {
        remove_any(&stage).map_err(|e| OpError::io("remove an unfinished earlier install", e))?;
        log(&format!("Removed an unfinished earlier install ({})", stage.display()));
    }
    let aside = base.join(ASIDE_NAME);
    if fs::symlink_metadata(&aside).is_ok() {
        if fs::symlink_metadata(dist).is_err() {
            rename(&aside, dist).map_err(|e| OpError::io("put the previous Purifier files back", e))?;
            log(&format!("Put the previous Purifier files back from {}", aside.display()));
        } else {
            remove_any(&aside).map_err(|e| OpError::io("remove the previous Purifier files", e))?;
            log(&format!("Removed leftover {}", aside.display()));
        }
    }
    Ok(())
}

/// Writes the whole build into `stage`: the Vencord files, anything else our
/// previous build's folder held, `package.json` (`{}`; it stops Node from
/// walking up to a stray package.json, which the CLI skips in dev-install
/// mode) and our build.json. Returns that build.json and the Vencord files of
/// the previous build that this one drops.
fn write_stage(
    stage: &Path,
    dist: &Path,
    build: &BuildFiles,
    was_ours: bool,
    now: &DateTime<Local>,
) -> Result<(Value, Vec<String>), OpError> {
    fs::create_dir_all(stage).map_err(|e| OpError::io("create staging folder", e))?;
    for name in &build.files {
        fs::copy(build.dir.join(name), stage.join(name)).map_err(|e| OpError::io(&format!("write {name}"), e))?;
    }
    let mut dropped = Vec::new();
    if was_ours {
        let rd = fs::read_dir(dist).map_err(|e| OpError::io("read the current Purifier files", e))?;
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if is_vencord_file(&n) {
                if !build.files.contains(&n) && e.path().is_file() {
                    dropped.push(n);
                }
                continue;
            }
            if n == "package.json" || n == BUILD_JSON || n.ends_with(".dopa-tmp") {
                continue;
            }
            let to = stage.join(&n);
            let kept = if e.path().is_dir() { copy_dir(&e.path(), &to) } else { fs::copy(e.path(), &to).map(|_| ()) };
            kept.map_err(|e| OpError::io(&format!("keep {n}"), e))?;
        }
    }
    fs::write(stage.join("package.json"), b"{}").map_err(|e| OpError::io("write package.json", e))?;
    let mut marked = build.build.clone();
    if let Value::Object(map) = &mut marked {
        map.insert("by".into(), Value::String(OUR_MARK.into()));
        map.insert("installedAt".into(), Value::String(now.to_rfc3339()));
    }
    let text = serde_json::to_string_pretty(&marked).unwrap_or_else(|_| "{}".into()) + "\n";
    fs::write(stage.join(BUILD_JSON), text.as_bytes()).map_err(|e| OpError::io("write build.json", e))?;
    Ok((marked, dropped))
}

/// Puts the build in place: a dist that is not ours becomes a backup, then
/// the build, `package.json` and our build.json go in. Either all of it
/// happens or none of it does.
pub fn place(env: &Env, build: &BuildFiles, now: DateTime<Local>, log: &dyn Fn(&str)) -> Result<PlaceOutcome, OpError> {
    place_with(env, build, now, log, &rename_retrying)
}

/// `place`, with the rename it uses passed in (tests make it fail).
pub fn place_with(
    env: &Env,
    build: &BuildFiles,
    now: DateTime<Local>,
    log: &dyn Fn(&str),
    rename: Rename,
) -> Result<PlaceOutcome, OpError> {
    let dist = env.dist();
    let base = env.vencord_base();
    fs::create_dir_all(&base).map_err(|e| OpError::io("create Vencord folder", e))?;
    recover(&base, &dist, rename, log)?;
    if dist.exists() && !dist.is_dir() {
        return Err(OpError::io("create dist folder", format!("{} is a file, not a folder", dist.display())));
    }
    let was_ours = detect::installed_build(env).is_some();

    let stage = base.join(STAGE_NAME);
    let (marked, dropped) = match write_stage(&stage, &dist, build, was_ours, &now) {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_dir_all(&stage);
            return Err(e);
        }
    };

    // Where the current dist goes during the swap: a folder that is not ours
    // becomes a backup; our own build (or an empty folder) is thrown away after.
    let mut backup = None;
    let aside = if !dist.exists() {
        None
    } else if !was_ours && dir_has_entries(&dist) {
        let mut target = base.join(backup_name(&now));
        let mut n = 2;
        while target.exists() {
            target = base.join(format!("{}-{n}", backup_name(&now)));
            n += 1;
        }
        backup = Some(target.clone());
        Some(target)
    } else {
        Some(base.join(ASIDE_NAME))
    };

    if let Some(a) = &aside {
        if let Err(e) = rename(&dist, a) {
            let _ = fs::remove_dir_all(&stage);
            return Err(OpError::io("move the current Vencord files aside", e));
        }
    }
    if let Err(e) = rename(&stage, &dist) {
        let _ = fs::remove_dir_all(&stage);
        if let Some(a) = &aside {
            if let Err(back) = rename(a, &dist) {
                log(&format!("Could not put {} back to {}: {back}", a.display(), dist.display()));
                return Err(OpError::io(
                    "move the new files into place",
                    format!("{e}; putting the old files back failed too ({back}), they are in {}", a.display()),
                ));
            }
        }
        return Err(OpError::io("move the new files into place", e));
    }

    match (&backup, &aside) {
        (Some(b), _) => log(&format!("Backed up the previous Vencord files to {}", b.display())),
        (None, Some(a)) => {
            if let Err(e) = fs::remove_dir_all(a) {
                log(&format!("Could not remove {} ({e}); the next run will", a.display()));
            }
        }
        (None, None) => {}
    }
    for n in &dropped {
        log(&format!("Removed old file {n}"));
    }
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
