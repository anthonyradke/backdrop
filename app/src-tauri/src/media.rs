//! The `media://` protocol: serves files from the local library to the player and library windows,
//! with HTTP range support so video can seek and loop without loading the whole file.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use tauri::http::{header, Request, Response, StatusCode};

/// Largest body sent for one range request; the player asks again for the rest.
const MAX_CHUNK: u64 = 4 << 20;

pub fn content_type(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "txt" | "glsl" | "frag" | "vert" => "text/plain; charset=utf-8",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Maps a request path like `/<id>/web/js/app.js` to a file under `root`, refusing anything that
/// could escape it.
pub fn resolve(root: &Path, url_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(url_path)?;
    let rel = decoded.trim_start_matches('/');
    let mut parts = rel.split('/');
    let id = parts.next()?;
    if !backdrop_common::valid_id(id) {
        return None;
    }
    let mut path = root.join(id);
    let mut any = false;
    for p in parts {
        if p.is_empty() || p.contains('\\') || p.contains(':') {
            return None;
        }
        let comp = Path::new(p).components().next()?;
        if !matches!(comp, Component::Normal(_)) || Path::new(p).components().count() != 1 {
            return None;
        }
        path.push(p);
        any = true;
    }
    any.then_some(path)
}

/// Parses `bytes=a-b`, `bytes=a-` and `bytes=-n` into an inclusive range clamped to `len`.
pub fn parse_range(h: &str, len: u64) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (len.saturating_sub(n), len - 1)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() { len - 1 } else { b.parse::<u64>().ok()?.min(len - 1) };
        (start, end)
    };
    (start <= end && start < len).then_some((start, end))
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .unwrap()
}

pub fn handle(root: &Path, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    // CORS preflight for crossOrigin video (the windows draw frames from it).
    if req.method() == tauri::http::Method::OPTIONS {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
            .body(Vec::new())
            .unwrap();
    }
    let Some(path) = resolve(root, req.uri().path()) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(mut file) = File::open(&path) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let ctype = content_type(&path);
    let builder = Response::builder()
        .header(header::CONTENT_TYPE, ctype)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-cache");

    let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    match range {
        Some(r) => {
            let Some((start, end)) = parse_range(r, len) else {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                    .body(Vec::new())
                    .unwrap();
            };
            let end = end.min(start + MAX_CHUNK - 1);
            let mut buf = vec![0u8; (end - start + 1) as usize];
            if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut buf)).is_err() {
                return empty(StatusCode::INTERNAL_SERVER_ERROR);
            }
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(header::CONTENT_LENGTH, buf.len())
                .body(buf)
                .unwrap()
        }
        None => {
            let mut buf = Vec::with_capacity(len as usize);
            if file.read_to_end(&mut buf).is_err() {
                return empty(StatusCode::INTERNAL_SERVER_ERROR);
            }
            builder.status(StatusCode::OK).header(header::CONTENT_LENGTH, buf.len()).body(buf).unwrap()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=0-1", 100), Some((0, 1)));
        assert_eq!(parse_range("bytes=90-200", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
    }

    #[test]
    fn paths() {
        let root = Path::new("/lib");
        let id = "0123456789abcdef";
        assert_eq!(resolve(root, &format!("/{id}/media.mp4")), Some(root.join(id).join("media.mp4")));
        assert_eq!(resolve(root, &format!("/{id}/web/a%20b.js")), Some(root.join(id).join("web").join("a b.js")));
        assert_eq!(resolve(root, &format!("/{id}/../x")), None);
        assert_eq!(resolve(root, &format!("/{id}/%2e%2e/x")), None);
        assert_eq!(resolve(root, &format!("/{id}/web/..%2f..%2fx")), None);
        assert_eq!(resolve(root, "/nothex/media.mp4"), None);
        assert_eq!(resolve(root, &format!("/{id}")), None);
        assert_eq!(resolve(root, &format!("/{id}/C:%5Cx")), None);
    }
}
