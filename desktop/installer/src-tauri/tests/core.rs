//! Tests for the installer core. Everything runs in sandboxes under
//! CARGO_TARGET_TMPDIR; nothing here reads or writes a real Discord install.
//! `full_sandbox_install_with_real_cli` downloads the pinned Vencord CLI once
//! (cached in CARGO_TARGET_TMPDIR) and runs it against a fake Discord tree.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::TimeZone;
use dopa_setup::core::asar;
use dopa_setup::core::detect::{self, State};
use dopa_setup::core::env::{same_path, Env};
use dopa_setup::core::fetch::{self, Pin, CLI_PIN};
use dopa_setup::core::net::{Fetcher, HttpFetcher, NetError, OfflineFetcher, Progress};
use dopa_setup::core::ops::{self, InstallRequest, UninstallRequest};
use dopa_setup::core::place;
use dopa_setup::core::procs;
use dopa_setup::core::sums;
use dopa_setup::core::{Branch, FailCode, Recorder, StepState};

/// The 196-byte app.asar stub from this PC's Discord Stable
/// (%LOCALAPPDATA%\Discord\app-1.0.9267\resources\app.asar, read with xxd -p;
/// sha256 34fa5f451143d164ddff9dbbc0e6a39202c562238f1c51570e7501870bf64a38).
const REAL_STUB_HEX: &str = "04000000600000005c000000580000007b2266696c6573223a7b22696e6465782e6a73223a7b2273697a65223a34392c226f6666736574223a2230227d2c227061636b6167652e6a736f6e223a7b2273697a65223a34332c226f6666736574223a223439227d7d7d726571756972652822443a5c5c646973636f72645c5c56656e636f72645c5c646973745c5c706174636865722e6a7322297b0a09226e616d65223a2022646973636f7264222c0a09226d61696e223a2022696e6465782e6a73220a7d";
const REAL_STUB_SHA256: &str = "34fa5f451143d164ddff9dbbc0e6a39202c562238f1c51570e7501870bf64a38";

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn fixture_build() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("build")
}

/// A fresh, empty sandbox folder for one test.
fn sandbox(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("sandboxes").join(name);
    // Drop CLI junctions first so nothing could ever be followed.
    for b in ["stable", "ptb", "canary"] {
        let link = dir.join("cli-view").join(b).join("DiscordDevelopment");
        if fs::symlink_metadata(&link).is_ok() {
            let _ = fs::remove_dir(&link);
        }
    }
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    std::path::absolute(dir).unwrap()
}

/// Discord's own app.asar stand-in: a valid archive, larger than a stub.
fn discord_asar(tag: &str) -> Vec<u8> {
    let filler = vec![b'x'; 80 * 1024];
    let pkg = format!("{{\"name\":\"discord_desktop\",\"tag\":\"{tag}\"}}");
    asar::build_archive(&[
        ("index.js", b"require('./app_bootstrap/index.js');"),
        ("package.json", pkg.as_bytes()),
        ("filler.bin", &filler),
    ])
}

enum Fake<'a> {
    Clean,
    Stub(&'a str),
}

/// Builds `<sandbox>\Local\<Discord dir>\app-<version>\resources` with an app.asar.
fn fake_discord(env: &Env, branch: Branch, version: &str, kind: Fake) -> PathBuf {
    let dir = env.discord_dir(branch);
    let res = dir.join(format!("app-{version}")).join("resources");
    fs::create_dir_all(&res).unwrap();
    fs::write(dir.join("Update.exe"), b"not a real Update.exe").unwrap();
    let original = discord_asar(branch.id());
    match kind {
        Fake::Clean => fs::write(res.join("app.asar"), &original).unwrap(),
        Fake::Stub(target) => {
            fs::write(res.join("_app.asar"), &original).unwrap();
            fs::write(res.join("app.asar"), asar::build_stub(target)).unwrap();
        }
    }
    res
}

fn write_dist(env: &Env, files: &[(&str, &str)]) {
    let dist = env.dist();
    fs::create_dir_all(&dist).unwrap();
    for (n, c) in files {
        fs::write(dist.join(n), c).unwrap();
    }
}

fn our_patcher(env: &Env) -> String {
    env.our_patcher().to_string_lossy().to_string()
}

/// Serves canned bytes by URL.
struct FakeFetcher {
    map: Mutex<HashMap<String, Result<Vec<u8>, NetError>>>,
}

impl FakeFetcher {
    fn new(entries: Vec<(&str, Result<Vec<u8>, NetError>)>) -> Arc<Self> {
        Arc::new(FakeFetcher { map: Mutex::new(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect()) })
    }
    fn lookup(&self, url: &str) -> Result<Vec<u8>, NetError> {
        self.map.lock().unwrap().get(url).cloned().unwrap_or_else(|| Err(NetError::Status(404, url.to_string())))
    }
}

impl Fetcher for FakeFetcher {
    fn get(&self, url: &str) -> Result<Vec<u8>, NetError> {
        self.lookup(url)
    }
    fn download(&self, url: &str, dest: &Path, progress: Progress) -> Result<u64, NetError> {
        let b = self.lookup(url)?;
        fs::write(dest, &b).map_err(|e| NetError::Io(e.to_string()))?;
        progress(b.len() as u64, Some(b.len() as u64));
        Ok(b.len() as u64)
    }
}

// ---------------------------------------------------------------- stubs

#[test]
fn real_196_byte_stub_parses_and_rebuilds_byte_for_byte() {
    let real = unhex(REAL_STUB_HEX);
    assert_eq!(real.len(), 196);
    assert_eq!(sums::sha256_bytes(&real), REAL_STUB_SHA256);
    let target = asar::parse_stub(&real).expect("the real stub parses");
    assert_eq!(target, r"D:\discord\Vencord\dist\patcher.js");
    // Our port of the CLI's WriteAppAsar produces exactly the same bytes.
    assert_eq!(asar::build_stub(&target), real);
    assert_eq!(asar::read_entry(&real, "package.json").unwrap(), asar::STUB_PACKAGE_JSON.as_bytes());
}

#[test]
fn stub_parsing_rejects_non_stubs() {
    assert_eq!(asar::parse_stub(&discord_asar("x")), None, "large archives are never stubs");
    let small = asar::build_archive(&[("index.js", b"console.log('hi')")]);
    assert_eq!(asar::parse_stub(&small), None);
    let not_string = asar::build_archive(&[("index.js", b"require(path)")]);
    assert_eq!(asar::parse_stub(&not_string), None);
    assert_eq!(asar::parse_stub(b"garbage"), None);
    assert_eq!(asar::parse_stub(&[]), None);
    let semi = asar::build_archive(&[("index.js", br#"require("C:\\x\\patcher.js");"#)]);
    assert_eq!(asar::parse_stub(&semi).as_deref(), Some(r"C:\x\patcher.js"));
}

#[test]
fn stub_writer_escapes_like_go() {
    let p = r"C:\Users\Tom & Jerry\AppData\Roaming\Vencord\dist\patcher.js";
    let stub = asar::build_stub(p);
    let index = std::str::from_utf8(asar::read_entry(&stub, "index.js").unwrap()).unwrap();
    assert!(index.contains(r"Tom \u0026 Jerry"), "{index}");
    assert_eq!(asar::parse_stub(&stub).as_deref(), Some(p));
}

// ---------------------------------------------------------------- detection

#[test]
fn detects_clean_ours_and_custom_installs() {
    let sb = sandbox("detect-mixed");
    let mut env = Env::sandboxed(sb, None, Arc::new(OfflineFetcher));
    env.sandbox_running = vec![Branch::Canary];
    fake_discord(&env, Branch::Stable, "1.0.9999", Fake::Clean);
    fake_discord(&env, Branch::Ptb, "1.0.1231", Fake::Stub(&our_patcher(&env)));
    fake_discord(&env, Branch::Canary, "1.0.1314", Fake::Stub(r"D:\dev\Vencord\dist\patcher.js"));
    write_dist(
        &env,
        &[
            ("patcher.js", "// Vencord abc"),
            ("build.json", r#"{"purifier":"4.2.0","hash":"abc1234","by":"dopas-purifier"}"#),
        ],
    );

    let found = detect::scan(&env);
    let states: Vec<(Branch, State)> = found.iter().map(|i| (i.branch, i.state)).collect();
    assert_eq!(
        states,
        vec![(Branch::Stable, State::Clean), (Branch::Ptb, State::Ours), (Branch::Canary, State::Custom)]
    );
    let canary = &found[2];
    assert!(canary.running);
    assert!(!found[0].running);
    assert_eq!(canary.patcher.as_deref(), Some(r"D:\dev\Vencord\dist\patcher.js"));
    assert!(canary.original_asar);
    assert_eq!(found[1].version, "1.0.1231");
    assert_eq!(detect::installed_build(&env).unwrap()["hash"], "abc1234");

    let d = detect::detect(&env);
    assert_eq!(d.network, "offline");
    assert!(d.latest.is_none());
    assert_eq!(d.installs.len(), 3);
}

#[test]
fn detects_official_vencord_and_picks_newest_app_folder() {
    let sb = sandbox("detect-vencord");
    let env = Env::sandboxed(sb, None, Arc::new(OfflineFetcher));
    // The older folder is clean; the newest (by number, not by text) is patched.
    fake_discord(&env, Branch::Stable, "1.0.9999", Fake::Clean);
    fake_discord(&env, Branch::Stable, "1.0.10000", Fake::Stub(&our_patcher(&env)));
    write_dist(&env, &[("patcher.js", "// Vencord 1234567")]);
    let i = detect::scan_branch(&env, Branch::Stable).unwrap();
    assert_eq!(i.version, "1.0.10000");
    assert_eq!(i.state, State::Vencord, "same patcher path, no build.json of ours");

    // A build.json that is not ours does not make it ours.
    write_dist(&env, &[("build.json", r#"{"by":"someone-else"}"#)]);
    assert_eq!(detect::scan_branch(&env, Branch::Stable).unwrap().state, State::Vencord);

    // Path comparison ignores case and slash style.
    let odd = our_patcher(&env).to_uppercase().replace('\\', "/");
    assert!(same_path(&odd, &our_patcher(&env)));
}

#[test]
fn unknown_states_and_missing_installs() {
    let sb = sandbox("detect-unknown");
    let env = Env::sandboxed(sb, None, Arc::new(OfflineFetcher));
    assert!(detect::scan(&env).is_empty());
    let res = fake_discord(&env, Branch::Stable, "1.0.1", Fake::Clean);
    fs::write(res.join("_app.asar"), b"leftover").unwrap();
    assert_eq!(detect::scan_branch(&env, Branch::Stable).unwrap().state, State::Unknown);
    let res = fake_discord(&env, Branch::Ptb, "1.0.1", Fake::Stub(r"C:\somewhere\index.js"));
    assert!(res.is_dir());
    assert_eq!(detect::scan_branch(&env, Branch::Ptb).unwrap().state, State::Unknown);
}

#[test]
fn local_build_is_reported_as_latest() {
    let sb = sandbox("detect-local");
    let env = Env::sandboxed(sb, Some(fixture_build()), Arc::new(OfflineFetcher));
    let (latest, net) = detect::latest(&env);
    assert_eq!(net, "local");
    let l = latest.unwrap();
    assert_eq!(l.hash.as_deref(), Some("f1a2b3c"));
    assert!(l.title.ends_with(" f1a2b3c"));
}

// ---------------------------------------------------------------- env hooks

#[test]
fn env_hooks_map_sandbox_dirs() {
    let vars: HashMap<&str, &str> = [
        ("DOPA_SANDBOX", r"E:\sb\one"),
        ("DOPA_LOCAL_BUILD", r"E:\sb\build"),
        ("DOPA_SANDBOX_RUNNING", "stable, canary,nope"),
        ("LOCALAPPDATA", r"C:\Users\x\AppData\Local"),
        ("APPDATA", r"C:\Users\x\AppData\Roaming"),
    ]
    .into_iter()
    .collect();
    let env = Env::from_lookup(|k| vars.get(k).map(|v| v.into()), Arc::new(OfflineFetcher)).unwrap();
    assert_eq!(env.local, PathBuf::from(r"E:\sb\one\Local"));
    assert_eq!(env.roaming, PathBuf::from(r"E:\sb\one\Roaming"));
    assert_eq!(env.dist(), PathBuf::from(r"E:\sb\one\Roaming\Vencord\dist"));
    assert_eq!(env.cache_dir(), PathBuf::from(r"E:\sb\one\Local\DopasPurifier\cache"));
    assert_eq!(env.local_build, Some(PathBuf::from(r"E:\sb\build")));
    assert_eq!(env.sandbox_running, vec![Branch::Stable, Branch::Canary]);
    assert!(env.is_sandbox());

    let real: HashMap<&str, &str> =
        [("LOCALAPPDATA", r"C:\Users\x\AppData\Local"), ("APPDATA", r"C:\Users\x\AppData\Roaming")]
            .into_iter()
            .collect();
    let env = Env::from_lookup(|k| real.get(k).map(|v| v.into()), Arc::new(OfflineFetcher)).unwrap();
    assert!(!env.is_sandbox());
    assert_eq!(env.our_patcher(), PathBuf::from(r"C:\Users\x\AppData\Roaming\Vencord\dist\patcher.js"));
}

#[test]
fn only_known_links_may_open() {
    for ok in [
        "https://github.com/codemaker66/discord-stuff",
        "https://github.com/codemaker66/discord-stuff/releases/latest",
        "https://codemaker66.github.io/discord-stuff/",
        "https://codemaker66.github.io/discord-stuff/#desktop",
        "https://discord.com/download",
    ] {
        assert!(dopa_setup::url_allowed(ok), "{ok}");
    }
    for bad in [
        "https://github.com/codemaker66/discord-stuffed",
        "https://github.com/codemaker66/discord-stuff.evil.com",
        "http://github.com/codemaker66/discord-stuff",
        "https://discord.com/downloads/evil",
        "https://discord.com/download\" & calc",
        "file:///C:/Windows/System32/calc.exe",
        "https://codemaker66.github.io.evil.com/discord-stuff/",
        "",
    ] {
        assert!(!dopa_setup::url_allowed(bad), "{bad}");
    }
}

// ---------------------------------------------------------------- checksums

#[test]
fn sums_parse_and_title_hash() {
    let s = sums::parse_sums(&format!("{}  patcher.js\n", "aa".repeat(32))).unwrap();
    assert_eq!(s["patcher.js"], "aa".repeat(32));
    assert!(sums::parse_sums("nothex  x").is_err());
    assert!(sums::parse_sums("").is_err());
    let star = sums::parse_sums(&format!("{} *renderer.css\r\n", "B".repeat(64))).unwrap();
    assert_eq!(star["renderer.css"], "b".repeat(64));
    assert_eq!(
        fetch::title_hash("Dopa's Discord Purifier 4.2.0 for the Discord app · Vencord v1.14.1 · 94f9601").as_deref(),
        Some("94f9601")
    );
    assert_eq!(fetch::title_hash("no hash here"), None);
}

#[test]
fn local_build_with_a_tampered_file_is_refused() {
    let sb = sandbox("checksum-local");
    let src = sb.join("build");
    fs::create_dir_all(&src).unwrap();
    for e in fs::read_dir(fixture_build()).unwrap().flatten() {
        fs::copy(e.path(), src.join(e.file_name())).unwrap();
    }
    fs::write(src.join("renderer.js"), "// Vencord f1x7ure\n// tampered\n").unwrap();
    let env = Env::sandboxed(sb.clone(), Some(src), Arc::new(OfflineFetcher));
    let err = fetch::fetch_build(&env, &mut |_, _| {}, &|_| {}).unwrap_err();
    assert_eq!(err.code, FailCode::Checksum, "{err}");
    assert!(err.detail.contains("renderer.js"));

    // And a whole install stops before touching dist or Discord.
    let res = fake_discord(&env, Branch::Stable, "1.0.1", Fake::Clean);
    let before = fs::read(res.join("app.asar")).unwrap();
    seed_cli(&env);
    let rec = Recorder::default();
    let f =
        ops::install(&env, &InstallRequest { branches: vec![Branch::Stable], ..Default::default() }, &rec).unwrap_err();
    assert_eq!(f.code, FailCode::Checksum);
    assert_eq!(f.step.as_deref(), Some("fetch-build"));
    assert!(f.log.contains("FAILED at fetch-build"));
    assert!(!env.dist().exists(), "dist must not be created");
    assert_eq!(fs::read(res.join("app.asar")).unwrap(), before);
    assert!(rec.final_states().contains(&("fetch-build".into(), StepState::Error)));
}

#[test]
fn cli_download_with_wrong_hash_is_refused_and_deleted() {
    let sb = sandbox("checksum-cli");
    let net = FakeFetcher::new(vec![(CLI_PIN.url, Ok(b"definitely not the Vencord installer".to_vec()))]);
    let env = Env::sandboxed(sb, None, net);
    let err = fetch::ensure_cli(&env, &CLI_PIN, &mut |_| {}, &|_| {}).unwrap_err();
    assert_eq!(err.code, FailCode::Checksum);
    let left: Vec<_> = fs::read_dir(env.cache_dir()).unwrap().flatten().collect();
    assert!(left.is_empty(), "nothing may stay in the cache: {left:?}");

    // A damaged cached copy is replaced, and a good download is accepted.
    let good = b"pretend installer".to_vec();
    let pin = Pin {
        version: "vTest",
        url: "https://example.invalid/cli.exe",
        size: good.len() as u64,
        sha256: Box::leak(sums::sha256_bytes(&good).into_boxed_str()),
    };
    fs::write(env.cache_dir().join("VencordInstallerCli-vTest.exe"), b"damaged").unwrap();
    let env2 = Env::sandboxed(env.sandbox.clone().unwrap(), None, FakeFetcher::new(vec![(pin.url, Ok(good.clone()))]));
    let p = fetch::ensure_cli(&env2, &pin, &mut |_| {}, &|_| {}).unwrap();
    assert_eq!(fs::read(p).unwrap(), good);
}

/// A fake GitHub release for the fixture build.
fn fake_release(env: &Env, tamper: Option<&str>) -> Arc<FakeFetcher> {
    let base = "https://github.com/codemaker66/discord-stuff/releases/download/desktop-v4.2.0-f1a2b3c";
    let names = ["patcher.js", "preload.js", "renderer.js", "renderer.css", "build.json", "SHA256SUMS.txt"];
    let assets: Vec<serde_json::Value> = names
        .iter()
        .map(|n| {
            let size = fs::metadata(fixture_build().join(n)).unwrap().len();
            serde_json::json!({ "name": n, "browser_download_url": format!("{base}/{n}"), "size": size })
        })
        .collect();
    let release = serde_json::json!({
        "name": "Dopa's Discord Purifier 4.2.0 for the Discord app · Vencord v1.14.1 · f1a2b3c",
        "tag_name": "desktop-v4.2.0-f1a2b3c",
        "html_url": "https://github.com/codemaker66/discord-stuff/releases/tag/desktop-v4.2.0-f1a2b3c",
        "assets": assets,
    });
    let mut entries: Vec<(String, Result<Vec<u8>, NetError>)> =
        vec![(env.latest_release_url(), Ok(release.to_string().into_bytes()))];
    for n in names {
        let mut bytes = fs::read(fixture_build().join(n)).unwrap();
        if Some(n) == tamper {
            bytes.extend_from_slice(b"\n// evil\n");
        }
        entries.push((format!("{base}/{n}"), Ok(bytes)));
    }
    Arc::new(FakeFetcher { map: Mutex::new(entries.into_iter().collect()) })
}

#[test]
fn github_build_is_verified_and_tampering_refused() {
    let sb = sandbox("github-build");
    let probe = Env::sandboxed(sb.clone(), None, Arc::new(OfflineFetcher));
    let env = Env::sandboxed(sb.clone(), None, fake_release(&probe, None));
    let b = fetch::fetch_build(&env, &mut |_, _| {}, &|_| {}).unwrap();
    assert_eq!(b.files, vec!["patcher.js", "preload.js", "renderer.css", "renderer.js"]);
    assert_eq!(b.build["hash"], "f1a2b3c");
    assert_eq!(b.title.as_deref().and_then(fetch::title_hash).as_deref(), Some("f1a2b3c"));

    let sb2 = sandbox("github-build-tampered");
    let env = Env::sandboxed(sb2, None, fake_release(&probe, Some("preload.js")));
    let err = fetch::fetch_build(&env, &mut |_, _| {}, &|_| {}).unwrap_err();
    assert_eq!(err.code, FailCode::Checksum);
    assert!(err.detail.contains("preload.js"));

    let sb3 = sandbox("github-none");
    let env = Env::sandboxed(sb3, None, FakeFetcher::new(vec![]));
    assert_eq!(fetch::fetch_build(&env, &mut |_, _| {}, &|_| {}).unwrap_err().code, FailCode::NoRelease);
    let env = Env::sandboxed(sandbox("github-offline"), None, Arc::new(OfflineFetcher));
    assert_eq!(fetch::fetch_build(&env, &mut |_, _| {}, &|_| {}).unwrap_err().code, FailCode::Offline);
}

// ---------------------------------------------------------------- place

#[test]
fn place_backs_up_a_foreign_dist_once() {
    let sb = sandbox("place-backup");
    let env = Env::sandboxed(sb, Some(fixture_build()), Arc::new(OfflineFetcher));
    write_dist(&env, &[("patcher.js", "// Vencord official1"), ("renderer.js", "official"), ("extra.txt", "keep me")]);
    let build = fetch::fetch_build(&env, &mut |_, _| {}, &|_| {}).unwrap();
    let now = chrono::Local.with_ymd_and_hms(2026, 11, 9, 9, 43, 0).unwrap();
    let out = place::place(&env, &build, now, &|_| {}).unwrap();

    let backup = out.backup.expect("a backup was made");
    assert_eq!(backup.file_name().unwrap(), "dist-backup-20261109-094300");
    assert_eq!(fs::read_to_string(backup.join("patcher.js")).unwrap(), "// Vencord official1");
    assert_eq!(fs::read_to_string(backup.join("extra.txt")).unwrap(), "keep me");

    let dist = env.dist();
    for n in ["patcher.js", "preload.js", "renderer.js", "renderer.css"] {
        assert_eq!(fs::read(dist.join(n)).unwrap(), fs::read(fixture_build().join(n)).unwrap(), "{n}");
    }
    assert_eq!(fs::read_to_string(dist.join("package.json")).unwrap(), "{}");
    let bj: serde_json::Value = serde_json::from_str(&fs::read_to_string(dist.join("build.json")).unwrap()).unwrap();
    assert_eq!(bj["by"], "dopas-purifier");
    assert_eq!(bj["hash"], "f1a2b3c");
    assert_eq!(bj["purifier"], "4.2.0");
    assert!(!dist.join("extra.txt").exists());
    assert_eq!(place::list_backups(&env), vec![backup.clone()]);

    // Placing again over our own build makes no second backup.
    let later = chrono::Local.with_ymd_and_hms(2026, 11, 9, 10, 0, 0).unwrap();
    let again = place::place(&env, &build, later, &|_| {}).unwrap();
    assert!(again.backup.is_none());
    assert_eq!(place::list_backups(&env).len(), 1);

    // remove_ours puts the backup back.
    let restored = place::remove_ours(&env, &|_| {}).unwrap();
    assert_eq!(restored, Some(backup));
    assert_eq!(fs::read_to_string(dist.join("patcher.js")).unwrap(), "// Vencord official1");
    assert!(place::list_backups(&env).is_empty());
}

// ---------------------------------------------------------------- full flow

/// Puts a verified copy of the pinned CLI into the sandbox's cache,
/// downloading it once per target dir.
fn seed_cli(env: &Env) {
    // Tests run in parallel; only one may download into the shared cache.
    static ONCE: Mutex<()> = Mutex::new(());
    let _lock = ONCE.lock().unwrap_or_else(|e| e.into_inner());
    let shared =
        Env::sandboxed(Path::new(env!("CARGO_TARGET_TMPDIR")).join("cli-download"), None, Arc::new(HttpFetcher::new()));
    let cli = fetch::ensure_cli(&shared, &CLI_PIN, &mut |_| {}, &|l| eprintln!("{l}"))
        .expect("download the pinned Vencord CLI");
    fs::create_dir_all(env.cache_dir()).unwrap();
    fs::copy(&cli, env.cache_dir().join(cli.file_name().unwrap())).unwrap();
}

fn running_discords() -> Vec<String> {
    let mut v: Vec<String> = procs::process_names()
        .into_iter()
        .filter(|n| Branch::ALL.iter().any(|b| n.eq_ignore_ascii_case(b.exe())))
        .collect();
    v.sort();
    v.dedup();
    v
}

#[test]
fn full_sandbox_install_with_real_cli() {
    let real_before = running_discords();
    let sb = sandbox("full-install");
    let mut env = Env::sandboxed(sb.clone(), Some(fixture_build()), Arc::new(OfflineFetcher));
    env.sandbox_running = vec![Branch::Ptb];
    let our = our_patcher(&env);
    assert!(our.starts_with(&*sb.to_string_lossy()), "{our}");

    // Stable: clean. PTB: official Vencord. Canary: a developer's own build.
    let stable_res = fake_discord(&env, Branch::Stable, "1.0.9999", Fake::Clean);
    let ptb_res = fake_discord(&env, Branch::Ptb, "1.0.1231", Fake::Stub(&our));
    let canary_res = fake_discord(&env, Branch::Canary, "1.0.1314", Fake::Stub(r"D:\dev\Vencord\dist\patcher.js"));
    write_dist(
        &env,
        &[
            ("patcher.js", "// Vencord 1234567\n"),
            ("preload.js", "official"),
            ("renderer.js", "official"),
            ("renderer.css", "official"),
        ],
    );
    let stable_original = fs::read(stable_res.join("app.asar")).unwrap();
    let ptb_original = fs::read(ptb_res.join("_app.asar")).unwrap();
    let canary_stub = fs::read(canary_res.join("app.asar")).unwrap();
    seed_cli(&env);

    let rec = Recorder::default();
    let req = InstallRequest { branches: vec![Branch::Stable, Branch::Ptb, Branch::Canary], ..Default::default() };
    let summary = match ops::install(&env, &req, &rec) {
        Ok(s) => s,
        Err(f) => panic!("install failed: {f:?}"),
    };

    // Stable is patched by the real CLI: its stub requires our patcher in the
    // sandbox, and Discord's own archive moved to _app.asar unchanged.
    let target = asar::read_stub(&stable_res.join("app.asar")).unwrap().expect("stable app.asar is a stub");
    assert!(same_path(&target, &sb.join(r"Roaming\Vencord\dist\patcher.js").to_string_lossy()), "{target}");
    assert_eq!(fs::read(stable_res.join("_app.asar")).unwrap(), stable_original);
    assert!(fs::metadata(stable_res.join("app.asar")).unwrap().len() < 400);
    // PTB already pointed at the shared Vencord folder; Canary is someone's own build.
    assert_eq!(fs::read(ptb_res.join("_app.asar")).unwrap(), ptb_original);
    assert_eq!(fs::read(canary_res.join("app.asar")).unwrap(), canary_stub);

    let results: Vec<(Branch, &str)> = summary.branches.iter().map(|r| (r.branch, r.result.as_str())).collect();
    assert_eq!(results, vec![(Branch::Stable, "patched"), (Branch::Ptb, "already"), (Branch::Canary, "kept-custom")]);
    assert_eq!(summary.started, vec![Branch::Ptb], "restarts what was running");
    let backup = summary.backup.clone().expect("official dist backed up");
    assert_eq!(fs::read_to_string(Path::new(&backup).join("patcher.js")).unwrap(), "// Vencord 1234567\n");
    assert_eq!(summary.build.as_ref().unwrap()["by"], "dopas-purifier");
    assert_eq!(fs::read_to_string(env.dist().join("package.json")).unwrap(), "{}");
    assert!(summary.log.contains("Successfully patched"), "CLI output is in the log");

    let states: Vec<(String, StepState)> = rec.final_states();
    let want = [
        ("close", StepState::Done),
        ("fetch-installer", StepState::Done),
        ("fetch-build", StepState::Done),
        ("place", StepState::Done),
        ("patch:stable", StepState::Done),
        ("patch:ptb", StepState::Skipped),
        ("patch:canary", StepState::Skipped),
        ("start", StepState::Done),
    ];
    assert_eq!(states, want.iter().map(|(s, st)| (s.to_string(), *st)).collect::<Vec<_>>());
    let events = rec.events.lock().unwrap().clone();
    assert_eq!(events.last().unwrap().pct, 100.0);
    assert!(events.windows(2).all(|w| w[1].pct >= w[0].pct), "progress never goes backwards");
    assert_eq!(rec.plans.lock().unwrap()[0].len(), 8);
    assert!(rec.lines.lock().unwrap().iter().any(|l| l.contains("[sandbox] would close Discord PTB")));

    let after: Vec<(Branch, State)> = detect::scan(&env).iter().map(|i| (i.branch, i.state)).collect();
    assert_eq!(after, vec![(Branch::Stable, State::Ours), (Branch::Ptb, State::Ours), (Branch::Canary, State::Custom)]);

    // Repair (force) re-runs the CLI over an already patched install.
    let rec2 = Recorder::default();
    let repaired = ops::install(
        &env,
        &InstallRequest { branches: vec![Branch::Stable], force: true, ..Default::default() },
        &rec2,
    )
    .unwrap();
    assert_eq!(repaired.branches[0].result, "patched");
    assert!(repaired.log.contains("already patched. Unpatching first"));
    assert_eq!(fs::read(stable_res.join("_app.asar")).unwrap(), stable_original);

    // Uninstall (remove Vencord): both go back to Discord's own files and the
    // official files that were there before come back.
    let rec3 = Recorder::default();
    let un = ops::uninstall(
        &env,
        &UninstallRequest { branches: vec![Branch::Stable, Branch::Ptb], keep_vencord: false },
        &rec3,
    )
    .unwrap();
    assert_eq!(fs::read(stable_res.join("app.asar")).unwrap(), stable_original);
    assert!(!stable_res.join("_app.asar").exists());
    assert_eq!(fs::read(ptb_res.join("app.asar")).unwrap(), ptb_original);
    assert!(un.restored.is_some());
    assert_eq!(fs::read_to_string(env.dist().join("patcher.js")).unwrap(), "// Vencord 1234567\n");
    assert_eq!(fs::read(canary_res.join("app.asar")).unwrap(), canary_stub, "Canary untouched");
    let after: Vec<(Branch, State)> = detect::scan(&env).iter().map(|i| (i.branch, i.state)).collect();
    assert_eq!(
        after,
        vec![(Branch::Stable, State::Clean), (Branch::Ptb, State::Clean), (Branch::Canary, State::Custom)]
    );

    // Every real Discord that was running on this PC still is.
    let real_after = running_discords();
    for exe in &real_before {
        assert!(real_after.contains(exe), "{exe} was running before the test and is gone now");
    }
}

#[test]
fn install_refuses_missing_discord_and_bad_selection() {
    let sb = sandbox("refusals");
    let env = Env::sandboxed(sb, Some(fixture_build()), Arc::new(OfflineFetcher));
    let rec = Recorder::default();
    let f =
        ops::install(&env, &InstallRequest { branches: vec![Branch::Stable], ..Default::default() }, &rec).unwrap_err();
    assert_eq!(f.code, FailCode::NoDiscord);
    fake_discord(&env, Branch::Stable, "1.0.1", Fake::Clean);
    let f =
        ops::install(&env, &InstallRequest { branches: vec![Branch::Canary], ..Default::default() }, &rec).unwrap_err();
    assert_eq!(f.code, FailCode::Invalid);
    let f = ops::install(&env, &InstallRequest::default(), &rec).unwrap_err();
    assert_eq!(f.code, FailCode::Invalid);
    let f = ops::uninstall(&env, &UninstallRequest { branches: vec![Branch::Stable], keep_vencord: false }, &rec)
        .unwrap_err();
    assert_eq!(f.code, FailCode::Invalid, "nothing of ours to uninstall");
    assert!(rec.events.lock().unwrap().is_empty(), "refused before any step");
}

/// Live check of the GitHub API path against a repo that has releases
/// (our own has none yet). Run with `cargo test -- --ignored`.
#[test]
#[ignore = "needs the network"]
fn live_github_latest_release_parses() {
    let mut env = Env::sandboxed(sandbox("live-api"), None, Arc::new(HttpFetcher::new()));
    env.repo = "Vencord/Installer".into();
    let r = fetch::latest_release(&env).expect("GitHub reachable").expect("Vencord/Installer has releases");
    assert!(r.tag_name.starts_with('v'), "{}", r.tag_name);
    assert!(r.assets.iter().any(|a| a.name == "VencordInstallerCli.exe" && a.size > 1_000_000));
}

/// "Keep Vencord" uninstall against the real CLI and official Vencord's real
/// release (the CLI downloads it). Run with `cargo test -- --ignored`.
#[test]
#[ignore = "needs the network; downloads official Vencord"]
fn live_uninstall_keeping_official_vencord() {
    let sb = sandbox("live-keep-vencord");
    let env = Env::sandboxed(sb, Some(fixture_build()), Arc::new(OfflineFetcher));
    let res = fake_discord(&env, Branch::Stable, "1.0.9999", Fake::Clean);
    let original = fs::read(res.join("app.asar")).unwrap();
    seed_cli(&env);
    let rec = Recorder::default();
    ops::install(&env, &InstallRequest { branches: vec![Branch::Stable], ..Default::default() }, &rec).unwrap();
    let ours = fs::read(env.dist().join("patcher.js")).unwrap();

    let un = ops::uninstall(&env, &UninstallRequest { branches: vec![Branch::Stable], keep_vencord: true }, &rec)
        .unwrap_or_else(|f| panic!("{f:?}"));
    assert_eq!(un.branches[0].result, "vencord");
    let official = fs::read_to_string(env.dist().join("patcher.js")).unwrap();
    assert_ne!(official.as_bytes(), &ours[..], "the CLI replaced our patcher.js");
    assert!(official.starts_with("// Vencord "), "official banner: {}", &official[..40.min(official.len())]);
    assert!(fs::metadata(env.dist().join("renderer.js")).unwrap().len() > 100_000, "a real renderer.js");
    assert!(!env.dist().join("build.json").exists(), "our marker is gone");
    let i = detect::scan_branch(&env, Branch::Stable).unwrap();
    assert_eq!(i.state, State::Vencord);
    assert_eq!(fs::read(res.join("_app.asar")).unwrap(), original);
}
