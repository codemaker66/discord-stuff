//! SHA-256 helpers and the `SHA256SUMS.txt` format (`<hex>  <name>` per line,
//! as written by `sha256sum`; a `*` before the name marks binary mode).

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

pub fn sha256_bytes(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

/// Parses a SHA256SUMS file into name -> lowercase hex digest.
pub fn parse_sums(text: &str) -> Result<BTreeMap<String, String>, String> {
    let mut map = BTreeMap::new();
    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim_end_matches('\r').trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (digest, rest) =
            line.split_once(char::is_whitespace).ok_or_else(|| format!("SHA256SUMS line {} is malformed", i + 1))?;
        let name = rest.trim_start().trim_start_matches('*').trim();
        if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) || name.is_empty() {
            return Err(format!("SHA256SUMS line {} is malformed", i + 1));
        }
        map.insert(name.to_string(), digest.to_ascii_lowercase());
    }
    if map.is_empty() {
        return Err("SHA256SUMS is empty".into());
    }
    Ok(map)
}

/// Checks a file against an expected digest.
pub fn verify_file(path: &Path, expected: &str) -> std::io::Result<bool> {
    Ok(sha256_file(path)?.eq_ignore_ascii_case(expected))
}
