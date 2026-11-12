//! A tiny HTTP server on 127.0.0.1 that serves the local library. It has two jobs:
//!
//! - A fallback for video the media:// protocol can't stream (`/<token>/<id>/media.mp4`). The token
//!   is random per session, so other local apps and web pages can't read the library.
//! - The origin HTML wallpapers run on (`/w/<item token>/<id>/web/...`). Tauri treats pages from a
//!   custom protocol such as media:// as the app itself and lets them call its commands; a page on
//!   127.0.0.1 is remote content, which can't. Each item gets its own token, so a page can only
//!   read its own files, and its HTML gets `webshim.js` for Wallpaper Engine's web API.

use crate::log;
use sha2::{Digest, Sha256};
use std::collections::hash_map::RandomState;
use std::fs::File;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Tried first, so HTML wallpapers keep the same origin (and their localStorage) between runs.
const PREFERRED_PORT: u16 = 47290;
/// Longest request or header line read; anything longer is dropped.
const MAX_LINE: u64 = 8 << 10;
/// Connections served at once; more are closed straight away.
const MAX_CONNECTIONS: usize = 64;
/// Wallpaper Engine's web API for HTML wallpapers, injected into their pages.
const WEB_SHIM: &str = include_str!("webshim.js");

fn token() -> String {
    // RandomState is seeded from the OS's random source.
    let a = RandomState::new().build_hasher().finish();
    let mut h = RandomState::new().build_hasher();
    h.write_u64(a);
    format!("{a:016x}{:016x}", h.finish())
}

#[derive(Clone)]
pub struct Loopback {
    /// `http://127.0.0.1:<port>/<token>/`, which reads the whole library.
    pub base: String,
    origin: String,
    secret: String,
}

impl Loopback {
    /// Where an HTML wallpaper's files are served from: `<web base><id>/web/index.html`.
    pub fn web_base(&self, id: &str) -> String {
        format!("{}/w/{}/", self.origin, item_token(&self.secret, id))
    }
}

/// The token for one item's HTML wallpaper, derived from the session secret.
fn item_token(secret: &str, id: &str) -> String {
    let mut h = Sha256::new();
    h.update(secret.as_bytes());
    h.update(b"/");
    h.update(id.as_bytes());
    h.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// Starts the server.
pub fn start(root: PathBuf) -> Option<Loopback> {
    let listener = TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).or_else(|_| TcpListener::bind("127.0.0.1:0")).ok()?;
    let port = listener.local_addr().ok()?.port();
    let secret = token();
    let lb = Loopback {
        base: format!("http://127.0.0.1:{port}/{secret}/"),
        origin: format!("http://127.0.0.1:{port}"),
        secret: secret.clone(),
    };
    let busy = Arc::new(AtomicUsize::new(0));
    std::thread::Builder::new()
        .name("backdrop-loopback".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                if busy.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    busy.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let (root, secret, busy) = (root.clone(), secret.clone(), busy.clone());
                std::thread::spawn(move || {
                    let _ = serve(stream, &root, &secret);
                    busy.fetch_sub(1, Ordering::SeqCst);
                });
            }
        })
        .ok()?;
    Some(lb)
}

/// What a request path asks for: a library path, and whether it came through an item's web base.
fn route(path: &str, secret: &str) -> Option<(String, bool)> {
    let rest = path.strip_prefix('/')?;
    if let Some(rest) = rest.strip_prefix("w/") {
        let (tok, rest) = rest.split_once('/')?;
        let (id, inner) = rest.split_once('/')?;
        // Only the item's own web folder, and only with its own token.
        if !crate::common::valid_id(id) || tok != item_token(secret, id) || !inner.starts_with("web/") {
            return None;
        }
        return Some((format!("/{rest}"), true));
    }
    let rest = rest.strip_prefix(secret)?.strip_prefix('/')?;
    Some((format!("/{rest}"), false))
}

/// Puts the shim at the start of the page's `<head>` (or as early as the markup allows), so it runs
/// before the wallpaper's own scripts and its API exists when they look for it.
fn inject_shim(html: &[u8]) -> Vec<u8> {
    let tag = format!("<script>{WEB_SHIM}</script>");
    let lower: Vec<u8> = html.iter().take(64 << 10).map(u8::to_ascii_lowercase).collect();
    let after = |needle: &[u8]| -> Option<usize> {
        let at = lower.windows(needle.len()).position(|w| w == needle)?;
        let close = lower[at..].iter().position(|&b| b == b'>')?;
        Some(at + close + 1)
    };
    let at = after(b"<head").or_else(|| after(b"<html")).or_else(|| after(b"<!doctype")).unwrap_or(0);
    let mut out = Vec::with_capacity(html.len() + tag.len());
    out.extend_from_slice(&html[..at]);
    out.extend_from_slice(tag.as_bytes());
    out.extend_from_slice(&html[at..]);
    out
}

/// Reads one line of at most `MAX_LINE` bytes.
fn read_line(reader: &mut impl BufRead, line: &mut String) -> io::Result<usize> {
    let n = reader.by_ref().take(MAX_LINE).read_line(line)?;
    if n as u64 == MAX_LINE && !line.ends_with('\n') {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "line too long"));
    }
    Ok(n)
}

fn respond(out: &mut TcpStream, status: &str, headers: &[(&str, String)]) -> io::Result<()> {
    let mut head = format!("HTTP/1.1 {status}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n");
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    out.write_all(head.as_bytes())
}

fn serve(stream: TcpStream, root: &Path, secret: &str) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut out = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    read_line(&mut reader, &mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let mut range = None;
    loop {
        let mut h = String::new();
        if read_line(&mut reader, &mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_string());
            }
        }
    }
    // CORS preflight: the windows load video with crossOrigin so they can draw frames from it.
    if method == "OPTIONS" {
        return respond(
            &mut out,
            "204 No Content",
            &[
                ("Access-Control-Allow-Methods", "GET, HEAD".into()),
                ("Access-Control-Allow-Headers", "Range".into()),
                ("Content-Length", "0".into()),
            ],
        );
    }
    if method != "GET" && method != "HEAD" {
        return respond(&mut out, "405 Method Not Allowed", &[("Content-Length", "0".into())]);
    }
    let path = target.split(['?', '#']).next().unwrap_or("");
    let Some((rest, web)) = route(path, secret) else {
        return respond(&mut out, "404 Not Found", &[("Content-Length", "0".into())]);
    };
    let Some(file_path) = crate::media::resolve(root, &rest) else {
        return respond(&mut out, "404 Not Found", &[("Content-Length", "0".into())]);
    };
    let Ok(mut file) = File::open(&file_path) else {
        return respond(&mut out, "404 Not Found", &[("Content-Length", "0".into())]);
    };
    let ctype = crate::media::content_type(&file_path).to_string();
    if web && ctype.starts_with("text/html") {
        // Pages are small, and the shim changes their length, so they're sent whole.
        let mut html = vec![];
        file.read_to_end(&mut html)?;
        let body = inject_shim(&html);
        respond(
            &mut out,
            "200 OK",
            &[("Content-Type", ctype), ("Content-Length", body.len().to_string()), ("Cache-Control", "no-cache".into())],
        )?;
        if method == "GET" {
            out.write_all(&body)?;
        }
        return Ok(());
    }
    let len = file.metadata()?.len();
    let (status, start, end) = match range.as_deref() {
        Some(r) => match crate::media::parse_range(r, len) {
            Some((s, e)) => ("206 Partial Content", s, e),
            None => {
                return respond(
                    &mut out,
                    "416 Range Not Satisfiable",
                    &[("Content-Range", format!("bytes */{len}")), ("Content-Length", "0".into())],
                )
            }
        },
        None => ("200 OK", 0, len.saturating_sub(1)),
    };
    let count = if len == 0 { 0 } else { end - start + 1 };
    let mut headers = vec![
        ("Content-Type", ctype),
        ("Accept-Ranges", "bytes".into()),
        ("Content-Length", count.to_string()),
        ("Cache-Control", "no-cache".into()),
    ];
    if status.starts_with("206") {
        headers.push(("Content-Range", format!("bytes {start}-{end}/{len}")));
    }
    respond(&mut out, status, &headers)?;
    if method == "HEAD" || count == 0 {
        return Ok(());
    }
    file.seek(SeekFrom::Start(start))?;
    // The player often drops the connection mid-stream when it seeks; that's not an error.
    if let Err(e) = io::copy(&mut file.take(count), &mut out) {
        if !matches!(e.kind(), io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted) {
            log(format!("loopback: {e}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(base: &str, path: &str, range: Option<&str>) -> (String, Vec<u8>) {
        let url = format!("{base}{path}");
        let rest = url.strip_prefix("http://").unwrap();
        let (host, p) = rest.split_once('/').unwrap();
        let mut s = TcpStream::connect(host).unwrap();
        let mut req = format!("GET /{p} HTTP/1.1\r\nHost: {host}\r\n");
        if let Some(r) = range {
            req.push_str(&format!("Range: {r}\r\n"));
        }
        req.push_str("\r\n");
        s.write_all(req.as_bytes()).unwrap();
        let mut buf = vec![];
        s.read_to_end(&mut buf).unwrap();
        let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (String::from_utf8_lossy(&buf[..split]).to_string(), buf[split + 4..].to_vec())
    }

    #[test]
    fn serves_ranges_and_needs_token() {
        let root = std::env::temp_dir().join(format!("backdrop-loop-{}", std::process::id()));
        let id = "0123456789abcdef";
        std::fs::create_dir_all(root.join(id)).unwrap();
        std::fs::write(root.join(id).join("media.mp4"), b"0123456789").unwrap();
        let lb = start(root.clone()).unwrap();
        let base = lb.base.clone();

        let (head, body) = get(&base, &format!("{id}/media.mp4"), Some("bytes=2-5"));
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.contains("Content-Range: bytes 2-5/10"));
        assert_eq!(head.matches("Access-Control-Allow-Origin: *").count(), 1);
        assert_eq!(body, b"2345");

        let (head, body) = get(&base, &format!("{id}/media.mp4"), None);
        assert!(head.starts_with("HTTP/1.1 200") && head.contains("video/mp4"));
        assert_eq!(body, b"0123456789");

        let wrong = base.rsplitn(3, '/').nth(2).unwrap().to_string() + "/nottoken/";
        let (head, _) = get(&wrong, &format!("{id}/media.mp4"), None);
        assert!(head.starts_with("HTTP/1.1 404"));
        let (head, _) = get(&base, &format!("{id}/../{id}/media.mp4"), None);
        assert!(head.starts_with("HTTP/1.1 404"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn web_pages_only_reach_their_own_folder() {
        let root = std::env::temp_dir().join(format!("backdrop-loop-web-{}", std::process::id()));
        let (id, other) = ("0123456789abcdef", "fedcba9876543210");
        for i in [id, other] {
            std::fs::create_dir_all(root.join(i).join("web")).unwrap();
            std::fs::write(root.join(i).join("web/index.html"), b"<!doctype html><html><head><title>t</title></head></html>").unwrap();
            std::fs::write(root.join(i).join("web/a.js"), b"1").unwrap();
            std::fs::write(root.join(i).join("media.mp4"), b"0123").unwrap();
        }
        let lb = start(root.clone()).unwrap();
        let web = lb.web_base(id);

        let (head, body) = get(&web, &format!("{id}/web/index.html"), None);
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        let body = String::from_utf8(body).unwrap();
        assert!(body.starts_with("<!doctype html><html><head><script>"), "{body}");
        assert!(body.ends_with("</script><title>t</title></head></html>"));
        let (head, body) = get(&web, &format!("{id}/web/a.js"), None);
        assert!(head.starts_with("HTTP/1.1 200") && body == b"1");

        // Not outside web/, not another item's files with this item's token.
        for path in [format!("{id}/media.mp4"), format!("{other}/web/a.js"), format!("{id}/web/../media.mp4")] {
            let (head, _) = get(&web, &path, None);
            assert!(head.starts_with("HTTP/1.1 404"), "{path}: {head}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shim_goes_into_the_head() {
        let s = |h: &str| String::from_utf8(inject_shim(h.as_bytes())).unwrap();
        assert!(s("<HTML><HEAD lang=x>").starts_with("<HTML><HEAD lang=x><script>"));
        assert!(s("<html><body>").starts_with("<html><script>"));
        assert!(s("<canvas></canvas>").starts_with("<script>"));
    }
}
