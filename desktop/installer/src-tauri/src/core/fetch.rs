//! Getting the two things the install needs, both verified before use:
//! the pinned Vencord installer CLI, and our release's Vencord build.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use super::env::Env;
use super::error::{FailCode, OpError};
use super::net::NetError;
use super::sums;

/// A file pinned by URL, size and SHA-256.
#[derive(Debug, Clone, Copy)]
pub struct Pin {
    pub version: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// Vencord/Installer v1.4.2, VencordInstallerCli.exe.
pub const CLI_PIN: Pin = Pin {
    version: "v1.4.2",
    url: "https://github.com/Vencord/Installer/releases/download/v1.4.2/VencordInstallerCli.exe",
    size: 8_215_552,
    sha256: "15268aba25625797bf562187dd87ddadf42882e079c7b6192880ad3e83353ef5",
};

/// The four files every Vencord build has; their `.map` and `.LEGAL.txt`
/// siblings come along when the release carries them.
pub const CORE_FILES: [&str; 4] = ["patcher.js", "preload.js", "renderer.js", "renderer.css"];
pub const SUMS_NAME: &str = "SHA256SUMS.txt";
pub const BUILD_JSON: &str = "build.json";

/// Same rule as Vencord's own updater (src/main/updater/http.ts).
pub fn is_vencord_file(name: &str) -> bool {
    CORE_FILES.iter().any(|p| name.starts_with(p))
}

/// Asset names become file names; refuse anything that could leave the folder.
pub fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() < 200
        && !name.contains(['/', '\\', ':', '\0'])
        && !name.contains("..")
        && name.chars().all(|c| !c.is_control())
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhAsset {
    pub name: String,
    pub browser_download_url: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhRelease {
    #[serde(default)]
    pub name: Option<String>,
    pub tag_name: String,
    #[serde(default)]
    pub html_url: Option<String>,
    #[serde(default)]
    pub assets: Vec<GhAsset>,
}

impl GhRelease {
    pub fn title(&self) -> String {
        self.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| self.tag_name.clone())
    }
}

/// The last space-separated word of a release title when it looks like a
/// commit hash (Vencord's updater reads the build hash from there).
pub fn title_hash(title: &str) -> Option<String> {
    let last = title.trim().rsplit(' ').next()?;
    (last.len() >= 7 && last.len() <= 40 && last.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| last.to_ascii_lowercase())
}

/// `GET /repos/<repo>/releases/latest`; `Ok(None)` when there is no release.
pub fn latest_release(env: &Env) -> Result<Option<GhRelease>, NetError> {
    let url = env.latest_release_url();
    match env.net.get(&url) {
        Ok(bytes) => serde_json::from_slice::<GhRelease>(&bytes)
            .map(Some)
            .map_err(|e| NetError::Offline(format!("unreadable release data: {e}"))),
        Err(NetError::Status(404, _)) => Ok(None),
        Err(e) => Err(e),
    }
}

fn checksum_error(what: &str, detail: String) -> OpError {
    OpError::new(
        FailCode::Checksum,
        format!("{what} didn't match its fingerprint, so nothing was installed. Try again in a minute."),
        detail,
    )
}

/// Returns a verified copy of the pinned CLI from the cache, downloading it
/// when missing or damaged. A download that does not match the pin is
/// deleted and refused.
pub fn ensure_cli(env: &Env, pin: &Pin, progress: &mut dyn FnMut(f64), log: &dyn Fn(&str)) -> Result<PathBuf, OpError> {
    let cache = env.cache_dir();
    fs::create_dir_all(&cache).map_err(|e| OpError::io("create cache folder", e))?;
    let path = cache.join(format!("VencordInstallerCli-{}.exe", pin.version));
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() == pin.size && sums::verify_file(&path, pin.sha256).unwrap_or(false) {
            log(&format!("Vencord installer {} already downloaded and verified", pin.version));
            progress(1.0);
            return Ok(path);
        }
        log("Cached Vencord installer is damaged; downloading it again");
        let _ = fs::remove_file(&path);
    }
    log(&format!("Downloading Vencord installer {} from {}", pin.version, pin.url));
    let part = cache.join(format!("VencordInstallerCli-{}.exe.part", pin.version));
    let size = pin.size;
    let result = env.net.download(pin.url, &part, &mut |done, total| {
        let t = total.unwrap_or(size).max(1);
        progress((done as f64 / t as f64).min(1.0));
    });
    if let Err(e) = result {
        let _ = fs::remove_file(&part);
        return Err(e.into());
    }
    let got = sums::sha256_file(&part).map_err(|e| OpError::io("read download", e))?;
    let len = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if !got.eq_ignore_ascii_case(pin.sha256) || len != pin.size {
        let _ = fs::remove_file(&part);
        return Err(checksum_error(
            "The Vencord installer download",
            format!(
                "VencordInstallerCli.exe: expected sha256 {} ({} bytes), got {} ({} bytes)",
                pin.sha256, pin.size, got, len
            ),
        ));
    }
    fs::rename(&part, &path).map_err(|e| OpError::io("save installer", e))?;
    log(&format!("Verified VencordInstallerCli.exe (sha256 {got})"));
    Ok(path)
}

/// A verified Vencord build sitting in a staging folder in the cache.
#[derive(Debug, Clone)]
pub struct BuildFiles {
    pub dir: PathBuf,
    /// Vencord file names (patcher.js, its .map, ...), without build.json.
    pub files: Vec<String>,
    /// The release's build.json.
    pub build: Value,
    /// "github" or "local".
    pub source: String,
    pub title: Option<String>,
}

fn staging_name(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// Which names to take from a sums list: the Vencord files plus build.json.
fn wanted_from_sums(sums: &BTreeMap<String, String>) -> Result<Vec<String>, OpError> {
    let mut wanted: Vec<String> =
        sums.keys().filter(|n| is_vencord_file(n) || n.as_str() == BUILD_JSON).cloned().collect();
    wanted.sort();
    for n in &wanted {
        if !safe_name(n) {
            return Err(OpError::new(
                FailCode::Invalid,
                "The release looks damaged.",
                format!("unsafe file name {n:?}"),
            ));
        }
    }
    for core in CORE_FILES.iter().chain([&BUILD_JSON]) {
        if !wanted.iter().any(|n| n == core) {
            return Err(OpError::new(
                FailCode::Invalid,
                "The release is missing files, so nothing was installed.",
                format!("{core} is not listed in {SUMS_NAME}"),
            ));
        }
    }
    Ok(wanted)
}

fn read_build(dir: &Path) -> Result<Value, OpError> {
    let text = fs::read_to_string(dir.join(BUILD_JSON)).map_err(|e| OpError::io("read build.json", e))?;
    serde_json::from_str::<Value>(&text)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| OpError::new(FailCode::Invalid, "The release looks damaged.", "build.json is not a JSON object"))
}

/// Fetches and verifies the build: from DOPA_LOCAL_BUILD when set, otherwise
/// from the latest GitHub release.
pub fn fetch_build(env: &Env, progress: &mut dyn FnMut(f64, &str), log: &dyn Fn(&str)) -> Result<BuildFiles, OpError> {
    match &env.local_build {
        Some(dir) => fetch_local(env, dir, progress, log),
        None => fetch_github(env, progress, log),
    }
}

fn fetch_local(
    env: &Env,
    src: &Path,
    progress: &mut dyn FnMut(f64, &str),
    log: &dyn Fn(&str),
) -> Result<BuildFiles, OpError> {
    log(&format!("Using the local build in {}", src.display()));
    let sums_text = fs::read_to_string(src.join(SUMS_NAME)).map_err(|e| OpError::io("read SHA256SUMS.txt", e))?;
    let sums = sums::parse_sums(&sums_text)
        .map_err(|e| OpError::new(FailCode::Invalid, "The build's checksum list is unreadable.", e))?;
    let wanted = wanted_from_sums(&sums)?;
    let stage = env.cache_dir().join("build-local");
    let _ = fs::remove_dir_all(&stage);
    fs::create_dir_all(&stage).map_err(|e| OpError::io("create staging folder", e))?;
    for (i, name) in wanted.iter().enumerate() {
        progress(i as f64 / wanted.len() as f64, name);
        let to = stage.join(name);
        fs::copy(src.join(name), &to).map_err(|e| OpError::io(&format!("copy {name}"), e))?;
        let got = sums::sha256_file(&to).map_err(|e| OpError::io("hash file", e))?;
        if !got.eq_ignore_ascii_case(&sums[name]) {
            let _ = fs::remove_dir_all(&stage);
            return Err(checksum_error(
                &format!("The build file {name}"),
                format!("{name}: SHA256SUMS says {}, file is {got}", sums[name]),
            ));
        }
        log(&format!("Verified {name}"));
    }
    progress(1.0, "");
    let build = read_build(&stage)?;
    Ok(BuildFiles {
        dir: stage,
        files: wanted.into_iter().filter(|n| n != BUILD_JSON).collect(),
        build,
        source: "local".into(),
        title: None,
    })
}

fn fetch_github(env: &Env, progress: &mut dyn FnMut(f64, &str), log: &dyn Fn(&str)) -> Result<BuildFiles, OpError> {
    log(&format!("Looking up the latest release of {}", env.repo));
    let release = latest_release(env)?.ok_or_else(|| {
        OpError::new(
            FailCode::NoRelease,
            "There's no Discord app release to install yet. Check back soon!",
            format!("{} has no published release", env.repo),
        )
    })?;
    let title = release.title();
    log(&format!("Latest release: {title}"));
    let assets: BTreeMap<&str, &GhAsset> = release.assets.iter().map(|a| (a.name.as_str(), a)).collect();
    let sums_asset = assets.get(SUMS_NAME).ok_or_else(|| {
        OpError::new(
            FailCode::Invalid,
            "The release is missing its checksum list, so nothing was installed.",
            format!("no {SUMS_NAME} in {}", release.tag_name),
        )
    })?;
    let sums_bytes = env.net.get(&sums_asset.browser_download_url)?;
    let sums = sums::parse_sums(&String::from_utf8_lossy(&sums_bytes))
        .map_err(|e| OpError::new(FailCode::Invalid, "The release's checksum list is unreadable.", e))?;
    // Every Vencord asset in the release must be listed in the sums.
    for a in &release.assets {
        if is_vencord_file(&a.name) && !sums.contains_key(&a.name) {
            return Err(checksum_error(
                &format!("The release file {}", a.name),
                format!("{} is not listed in {SUMS_NAME}", a.name),
            ));
        }
    }
    let wanted = wanted_from_sums(&sums)?;
    let mut total: u64 = 0;
    for n in &wanted {
        let a = assets.get(n.as_str()).ok_or_else(|| {
            OpError::new(
                FailCode::Invalid,
                "The release is missing files, so nothing was installed.",
                format!("{n} is listed in {SUMS_NAME} but not attached to the release"),
            )
        })?;
        total += a.size.max(1);
    }
    let key = title_hash(&title).unwrap_or_else(|| release.tag_name.clone());
    let stage = env.cache_dir().join(format!("build-{}", staging_name(&key)));
    fs::create_dir_all(&stage).map_err(|e| OpError::io("create staging folder", e))?;
    let mut done_bytes: u64 = 0;
    for name in &wanted {
        let asset = assets[name.as_str()];
        let expected = &sums[name];
        let to = stage.join(name);
        if to.is_file() && sums::verify_file(&to, expected).unwrap_or(false) {
            log(&format!("{name} already downloaded and verified"));
        } else {
            log(&format!("Downloading {name}"));
            let part = stage.join(format!("{name}.part"));
            let base = done_bytes;
            let size = asset.size.max(1);
            let r = env.net.download(&asset.browser_download_url, &part, &mut |d, _| {
                progress((base + d.min(size)) as f64 / total as f64, name);
            });
            if let Err(e) = r {
                let _ = fs::remove_file(&part);
                return Err(e.into());
            }
            let got = sums::sha256_file(&part).map_err(|e| OpError::io("hash file", e))?;
            if !got.eq_ignore_ascii_case(expected) {
                let _ = fs::remove_file(&part);
                return Err(checksum_error(
                    &format!("The download of {name}"),
                    format!("{name}: SHA256SUMS says {expected}, download is {got}"),
                ));
            }
            fs::rename(&part, &to).map_err(|e| OpError::io(&format!("save {name}"), e))?;
            log(&format!("Verified {name}"));
        }
        done_bytes += asset.size.max(1);
        progress(done_bytes as f64 / total as f64, name);
    }
    let build = read_build(&stage)?;
    if let (Some(h), Some(b)) = (title_hash(&title), build.get("hash").and_then(Value::as_str)) {
        if !b.eq_ignore_ascii_case(&h) {
            log(&format!("Note: build.json says hash {b}, the release title says {h}"));
        }
    }
    Ok(BuildFiles {
        dir: stage,
        files: wanted.into_iter().filter(|n| n != BUILD_JSON).collect(),
        build,
        source: "github".into(),
        title: Some(title),
    })
}
