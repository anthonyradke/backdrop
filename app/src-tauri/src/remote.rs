//! Client for the shared library server.

use backdrop_common::{Item, Listed};
use futures_util::StreamExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(6))
            .user_agent(concat!("backdrop/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client")
    })
}

fn msg(e: reqwest::Error) -> String {
    if e.is_connect() || e.is_timeout() {
        "can't reach the library server".into()
    } else {
        e.to_string()
    }
}

async fn check(res: reqwest::Response) -> Result<reqwest::Response, String> {
    if res.status().is_success() {
        return Ok(res);
    }
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v["error"].as_str().map(String::from))
        .unwrap_or_else(|| status.to_string());
    Err(detail)
}

pub async fn health(server: &str) -> Result<(), String> {
    let res = client().get(format!("{server}/api/health")).timeout(Duration::from_secs(8)).send().await.map_err(msg)?;
    let v: serde_json::Value = check(res).await?.json().await.map_err(msg)?;
    if v["app"] == "backdrop" {
        Ok(())
    } else {
        Err("that address isn't a Backdrop library".into())
    }
}

pub async fn list(server: &str) -> Result<Vec<Listed>, String> {
    let res = client().get(format!("{server}/api/items")).timeout(Duration::from_secs(10)).send().await.map_err(msg)?;
    check(res).await?.json().await.map_err(msg)
}

pub async fn rename(server: &str, id: &str, name: &str) -> Result<(), String> {
    let res = client()
        .patch(format!("{server}/api/items/{id}"))
        .json(&serde_json::json!({ "name": name }))
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(msg)?;
    check(res).await.map(|_| ())
}

pub async fn delete(server: &str, id: &str) -> Result<(), String> {
    let res = client().delete(format!("{server}/api/items/{id}")).timeout(Duration::from_secs(10)).send().await.map_err(msg)?;
    check(res).await.map(|_| ())
}

pub async fn upload(
    server: &str,
    path: &Path,
    filename: &str,
    name: &str,
    progress: impl Fn(u64, u64) + Send + Sync + 'static,
) -> Result<Item, String> {
    let file = tokio::fs::File::open(path).await.map_err(|e| e.to_string())?;
    let total = file.metadata().await.map_err(|e| e.to_string())?.len();
    let sent = Arc::new(AtomicU64::new(0));
    let stream = tokio_util::io::ReaderStream::with_capacity(file, 256 * 1024).map(move |chunk| {
        if let Ok(c) = &chunk {
            let n = sent.fetch_add(c.len() as u64, Ordering::Relaxed) + c.len() as u64;
            progress(n, total);
        }
        chunk
    });
    let res = client()
        .post(format!("{server}/api/upload"))
        .query(&[("filename", filename), ("name", name)])
        .header(reqwest::header::CONTENT_LENGTH, total)
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .map_err(msg)?;
    check(res).await?.json().await.map_err(msg)
}

pub async fn put_thumb(server: &str, id: &str, jpeg: Vec<u8>) -> Result<(), String> {
    let res = client()
        .put(format!("{server}/api/items/{id}/thumb"))
        .body(jpeg)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(msg)?;
    check(res).await.map(|_| ())
}

/// Streams the item's file to `dest` (via a `.part` file so a cut-off download never looks complete).
pub async fn download(
    server: &str,
    id: &str,
    dest: &Path,
    progress: impl Fn(u64, u64),
) -> Result<(), String> {
    let res = client().get(format!("{server}/api/items/{id}/file")).send().await.map_err(msg)?;
    let res = check(res).await?;
    let total = res.content_length().unwrap_or(0);
    let part = dest.with_extension("part");
    let mut out = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;
    let mut done = 0u64;
    let mut body = res.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(msg)?;
        out.write_all(&chunk).await.map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        progress(done, total);
    }
    out.flush().await.map_err(|e| e.to_string())?;
    drop(out);
    if total > 0 && done != total {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("download was cut off".into());
    }
    tokio::fs::rename(&part, dest).await.map_err(|e| e.to_string())
}

/// Returns false when the server has no thumbnail for the item.
pub async fn download_thumb(server: &str, id: &str, dest: &Path) -> Result<bool, String> {
    let res = client()
        .get(format!("{server}/api/items/{id}/thumb"))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(msg)?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(false);
    }
    let bytes = check(res).await?.bytes().await.map_err(msg)?;
    tokio::fs::write(dest, &bytes).await.map_err(|e| e.to_string())?;
    Ok(true)
}

/// Asks the server to make an H.264 copy (optionally smaller or at a lower frame rate). Returns the job.
pub async fn convert(
    server: &str,
    id: &str,
    max_height: Option<u32>,
    max_fps: Option<u32>,
) -> Result<serde_json::Value, String> {
    let res = client()
        .post(format!("{server}/api/items/{id}/convert"))
        .json(&serde_json::json!({ "maxHeight": max_height, "maxFps": max_fps }))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(msg)?;
    check(res).await?.json().await.map_err(msg)
}

pub async fn jobs(server: &str) -> Result<serde_json::Value, String> {
    let res = client().get(format!("{server}/api/jobs")).timeout(Duration::from_secs(10)).send().await.map_err(msg)?;
    check(res).await?.json().await.map_err(msg)
}
