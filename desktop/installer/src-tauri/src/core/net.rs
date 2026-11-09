//! HTTP access behind a small trait, so tests can run fully offline.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

pub const USER_AGENT: &str =
    concat!("DopasPurifierSetup/", env!("CARGO_PKG_VERSION"), " (+https://github.com/codemaker66/discord-stuff)");

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetError {
    /// No connection, DNS failure, TLS failure or a timeout.
    Offline(String),
    /// The server answered with an HTTP error status.
    Status(u16, String),
    /// Writing the download to disk failed.
    Io(String),
}

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NetError::Offline(m) => write!(f, "network unavailable: {m}"),
            NetError::Status(code, url) => write!(f, "HTTP {code} from {url}"),
            NetError::Io(m) => write!(f, "disk error: {m}"),
        }
    }
}

/// Download progress callback: bytes so far, total when known.
pub type Progress<'a> = &'a mut dyn FnMut(u64, Option<u64>);

pub trait Fetcher: Send + Sync {
    /// GETs a small resource (API JSON, checksum lists) into memory.
    fn get(&self, url: &str) -> Result<Vec<u8>, NetError>;
    /// Streams a resource to `dest`, returning the byte count.
    fn download(&self, url: &str, dest: &Path, progress: Progress) -> Result<u64, NetError>;
}

/// The real fetcher: ureq over Windows' own TLS stack (SChannel) and the
/// system's root certificates.
pub struct HttpFetcher {
    api: ureq::Agent,
    files: ureq::Agent,
}

impl HttpFetcher {
    pub fn new() -> Self {
        Self { api: Self::agent(Duration::from_secs(12)), files: Self::agent(Duration::from_secs(300)) }
    }

    fn agent(global: Duration) -> ureq::Agent {
        let tls = ureq::tls::TlsConfig::builder()
            .provider(ureq::tls::TlsProvider::NativeTls)
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .build();
        ureq::Agent::config_builder()
            .tls_config(tls)
            .user_agent(USER_AGENT)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_global(Some(global))
            .build()
            .into()
    }

    fn map_err(url: &str, e: ureq::Error) -> NetError {
        match e {
            ureq::Error::StatusCode(code) => NetError::Status(code, url.to_string()),
            ureq::Error::Io(io) => NetError::Offline(io.to_string()),
            other => NetError::Offline(other.to_string()),
        }
    }
}

impl Default for HttpFetcher {
    fn default() -> Self {
        Self::new()
    }
}

impl Fetcher for HttpFetcher {
    fn get(&self, url: &str) -> Result<Vec<u8>, NetError> {
        let mut resp = self
            .api
            .get(url)
            .header("Accept", "application/vnd.github+json, */*")
            .call()
            .map_err(|e| Self::map_err(url, e))?;
        resp.body_mut().with_config().limit(4 * 1024 * 1024).read_to_vec().map_err(|e| Self::map_err(url, e))
    }

    fn download(&self, url: &str, dest: &Path, progress: Progress) -> Result<u64, NetError> {
        let mut resp = self
            .files
            .get(url)
            .header("Accept", "application/octet-stream")
            .call()
            .map_err(|e| Self::map_err(url, e))?;
        // With a content-encoding the length is the compressed size, so it
        // cannot be compared with the decoded byte count.
        let encoded = resp.headers().get("content-encoding").is_some();
        let total = resp
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|_| !encoded);
        let mut reader = resp.body_mut().with_config().limit(512 * 1024 * 1024).reader();
        let mut out = fs::File::create(dest).map_err(|e| NetError::Io(e.to_string()))?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut done = 0u64;
        loop {
            let n = reader.read(&mut buf).map_err(|e| NetError::Offline(e.to_string()))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| NetError::Io(e.to_string()))?;
            done += n as u64;
            progress(done, total);
        }
        out.flush().map_err(|e| NetError::Io(e.to_string()))?;
        if let Some(t) = total {
            if t != done {
                return Err(NetError::Offline(format!("download ended early ({done} of {t} bytes)")));
            }
        }
        Ok(done)
    }
}

/// A fetcher that is always offline. Used when nothing should touch the network.
pub struct OfflineFetcher;

impl Fetcher for OfflineFetcher {
    fn get(&self, url: &str) -> Result<Vec<u8>, NetError> {
        Err(NetError::Offline(format!("offline (wanted {url})")))
    }
    fn download(&self, url: &str, _dest: &Path, _p: Progress) -> Result<u64, NetError> {
        Err(NetError::Offline(format!("offline (wanted {url})")))
    }
}
