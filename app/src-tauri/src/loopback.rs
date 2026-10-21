//! A tiny HTTP server on 127.0.0.1 that serves the local library, used by the player when a video
//! won't play through the media:// protocol (WebKitGTK can't stream custom schemes into its media
//! stack, and it's a safety net for any WebView that misbehaves). Requests must carry a random
//! token in the path, so other local apps and web pages can't read the library.

use crate::log;
use std::collections::hash_map::RandomState;
use std::fs::File;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

fn token() -> String {
    // RandomState is seeded from the OS's random source.
    let a = RandomState::new().build_hasher().finish();
    let mut h = RandomState::new().build_hasher();
    h.write_u64(a);
    format!("{a:016x}{:016x}", h.finish())
}

/// Starts the server and returns its base URL (`http://127.0.0.1:<port>/<token>/`).
pub fn start(root: PathBuf) -> Option<String> {
    let listener = TcpListener::bind("127.0.0.1:0").ok()?;
    let port = listener.local_addr().ok()?.port();
    let token = token();
    let prefix = format!("/{token}/");
    std::thread::Builder::new()
        .name("backdrop-loopback".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let (root, prefix) = (root.clone(), prefix.clone());
                std::thread::spawn(move || {
                    let _ = serve(stream, &root, &prefix);
                });
            }
        })
        .ok()?;
    Some(format!("http://127.0.0.1:{port}/{token}/"))
}

fn respond(out: &mut TcpStream, status: &str, headers: &[(&str, String)]) -> io::Result<()> {
    let mut head = format!("HTTP/1.1 {status}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n");
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    out.write_all(head.as_bytes())
}

fn serve(stream: TcpStream, root: &std::path::Path, prefix: &str) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut out = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let mut range = None;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
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
    let path = target.split('?').next().unwrap_or("");
    let Some(rest) = path.strip_prefix(prefix) else {
        return respond(&mut out, "404 Not Found", &[("Content-Length", "0".into())]);
    };
    let Some(file_path) = crate::media::resolve(root, &format!("/{rest}")) else {
        return respond(&mut out, "404 Not Found", &[("Content-Length", "0".into())]);
    };
    let Ok(mut file) = File::open(&file_path) else {
        return respond(&mut out, "404 Not Found", &[("Content-Length", "0".into())]);
    };
    let len = file.metadata()?.len();
    let ctype = crate::media::content_type(&file_path).to_string();
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
        let base = start(root.clone()).unwrap();

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
}
