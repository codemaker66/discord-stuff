//! Reading and writing the tiny asar "stub" that the Vencord installer puts in
//! place of Discord's `resources/app.asar`.
//!
//! An asar archive starts with a Chromium pickle: `u32 4`, `u32 header_size`,
//! then the header pickle (`u32 payload_size`, `u32 json_len`, the JSON text
//! padded to 4 bytes). File data starts at `8 + header_size`, and each file's
//! `offset` in the JSON is relative to that.
//!
//! The Vencord stub holds two files: `index.js`, which is exactly
//! `require("<patcher path as a JSON string>")`, and a `package.json`.
//! On this PC a real stub is 196 bytes.

use std::fs;
use std::io::Read;
use std::path::Path;

/// app.asar files larger than this are never treated as a stub (Discord's own
/// app.asar is several megabytes; a stub is a few hundred bytes).
pub const MAX_STUB_SIZE: u64 = 64 * 1024;

/// The package.json the Vencord installer writes into its stub, byte for byte
/// (Go source: app_asar.go, a raw string with tab indents).
pub const STUB_PACKAGE_JSON: &str = "{\n\t\"name\": \"discord\",\n\t\"main\": \"index.js\"\n}";

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    let s = b.get(at..at + 4)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// Returns the contents of one top-level file in an asar archive.
pub fn read_entry<'a>(archive: &'a [u8], name: &str) -> Option<&'a [u8]> {
    if u32_at(archive, 0)? != 4 {
        return None;
    }
    let header_size = u32_at(archive, 4)? as usize;
    let json_len = u32_at(archive, 12)? as usize;
    let json = archive.get(16..16usize.checked_add(json_len)?)?;
    let header: serde_json::Value = serde_json::from_slice(json).ok()?;
    let entry = header.get("files")?.get(name)?;
    let size = entry.get("size")?.as_u64()? as usize;
    let offset: usize = match entry.get("offset")? {
        serde_json::Value::String(s) => s.parse().ok()?,
        serde_json::Value::Number(n) => n.as_u64()? as usize,
        _ => return None,
    };
    let base = 8usize.checked_add(header_size)?;
    let start = base.checked_add(offset)?;
    archive.get(start..start.checked_add(size)?)
}

/// Parses `require("...")` (optionally followed by `;`) and returns the path.
pub fn parse_require(index_js: &str) -> Option<String> {
    let s = index_js.trim();
    let s = s.strip_suffix(';').unwrap_or(s).trim_end();
    let inner = s.strip_prefix("require(")?.strip_suffix(')')?.trim();
    if !inner.starts_with('"') {
        return None;
    }
    serde_json::from_str::<String>(inner).ok()
}

/// If `archive` is a Vencord-style stub, returns the path its index.js requires.
pub fn parse_stub(archive: &[u8]) -> Option<String> {
    if archive.len() as u64 > MAX_STUB_SIZE {
        return None;
    }
    let index = read_entry(archive, "index.js")?;
    parse_require(std::str::from_utf8(index).ok()?)
}

/// Reads `app.asar` and returns the stub's require target, or `None` when the
/// file is not a small stub (for example Discord's own archive).
pub fn read_stub(path: &Path) -> std::io::Result<Option<String>> {
    let meta = fs::metadata(path)?;
    if !meta.is_file() || meta.len() > MAX_STUB_SIZE {
        return Ok(None);
    }
    let mut buf = Vec::with_capacity(meta.len() as usize);
    fs::File::open(path)?.read_to_end(&mut buf)?;
    Ok(parse_stub(&buf))
}

/// Go's `json.Marshal` for a string: like serde_json, but it also escapes
/// `<`, `>`, `&`, U+2028 and U+2029.
fn go_json_string(s: &str) -> String {
    let base = serde_json::to_string(s).expect("string serializes");
    let mut out = String::with_capacity(base.len());
    for ch in base.chars() {
        match ch {
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c => out.push(c),
        }
    }
    out
}

/// Builds a stub exactly as Vencord Installer's `WriteAppAsar` does
/// (app_asar.go in Vencord/Installer v1.4.2). Used by tests and fixtures; the
/// real patching is always done by the official CLI.
pub fn build_stub(patcher_path: &str) -> Vec<u8> {
    let index_js = format!("require({})", go_json_string(patcher_path));
    let index_len = index_js.len();
    let header = format!(
        "{{\"files\":{{\"index.js\":{{\"size\":{},\"offset\":\"0\"}},\"package.json\":{{\"size\":{},\"offset\":\"{}\"}}}}}}",
        index_len,
        STUB_PACKAGE_JSON.len(),
        index_len
    );
    let str_len = header.len() as u32;
    let aligned = (str_len + 3) & !3;
    let mut padded = header.clone();
    for _ in str_len..aligned {
        padded.push('0');
    }
    let mut out = Vec::new();
    for n in [4u32, aligned + 8, aligned + 4, str_len] {
        out.extend_from_slice(&n.to_le_bytes());
    }
    out.extend_from_slice(padded.as_bytes());
    out.extend_from_slice(index_js.as_bytes());
    out.extend_from_slice(STUB_PACKAGE_JSON.as_bytes());
    out
}

/// Builds a small but valid asar archive with the given files, used by tests
/// to stand in for Discord's own app.asar.
pub fn build_archive(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut map = serde_json::Map::new();
    let mut data = Vec::new();
    for (name, bytes) in files {
        map.insert((*name).to_string(), serde_json::json!({ "size": bytes.len(), "offset": data.len().to_string() }));
        data.extend_from_slice(bytes);
    }
    let header = serde_json::to_string(&serde_json::json!({ "files": map })).unwrap();
    let str_len = header.len() as u32;
    let aligned = (str_len + 3) & !3;
    let mut out = Vec::new();
    for n in [4u32, aligned + 8, aligned + 4, str_len] {
        out.extend_from_slice(&n.to_le_bytes());
    }
    out.extend_from_slice(header.as_bytes());
    out.resize(out.len() + (aligned - str_len) as usize, 0);
    out.extend_from_slice(&data);
    out
}
