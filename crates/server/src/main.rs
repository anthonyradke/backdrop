//! Backdrop library server: stores wallpapers on disk and serves them to the apps.
//!
//! Layout under the data dir:
//!   items/<id>/meta.json, items/<id>/media.<ext> or wallpaper.zip, items/<id>/thumb.jpg
//!   releases/   app installers, listed at /downloads
//!   tmp/        uploads in progress

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use backdrop_common::{self as common, Item, Kind, Listed};
use futures_util::StreamExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;
use tower::ServiceExt;
use tower_http::services::ServeFile;

struct AppState {
    dir: PathBuf,
    items: RwLock<HashMap<String, Item>>,
    tmp_counter: AtomicU64,
}

type Shared = Arc<AppState>;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "error": msg.into() }))).into_response()
}

impl AppState {
    fn item_dir(&self, id: &str) -> PathBuf {
        self.dir.join("items").join(id)
    }

    async fn save_meta(&self, item: &Item) -> std::io::Result<()> {
        let json = serde_json::to_vec_pretty(item).expect("item serializes");
        let path = self.item_dir(&item.id).join("meta.json");
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, json).await?;
        tokio::fs::rename(&tmp, &path).await
    }
}

fn load_items(dir: &std::path::Path) -> HashMap<String, Item> {
    let mut out = HashMap::new();
    let Ok(entries) = std::fs::read_dir(dir.join("items")) else {
        return out;
    };
    for e in entries.flatten() {
        let meta = e.path().join("meta.json");
        match std::fs::read(&meta).map(|b| serde_json::from_slice::<Item>(&b)) {
            Ok(Ok(item)) if common::valid_id(&item.id) => {
                out.insert(item.id.clone(), item);
            }
            Ok(Err(e)) => tracing::warn!("bad {}: {e}", meta.display()),
            _ => {}
        }
    }
    out
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let dir = std::env::var_os("BACKDROP_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("backdrop-library"));
    let addr = std::env::var("BACKDROP_ADDR").unwrap_or_else(|_| "127.0.0.1:8092".into());
    for sub in ["items", "releases", "tmp"] {
        std::fs::create_dir_all(dir.join(sub)).expect("create data dir");
    }
    // Leftovers from uploads that were cut off.
    if let Ok(entries) = std::fs::read_dir(dir.join("tmp")) {
        for e in entries.flatten() {
            let _ = std::fs::remove_file(e.path());
        }
    }

    let items = load_items(&dir);
    tracing::info!("{} items in {}", items.len(), dir.display());
    let state = Arc::new(AppState { dir, items: RwLock::new(items), tmp_counter: AtomicU64::new(0) });

    let app = Router::new()
        .route("/", get(|| async { Html(include_str!("index.html")) }))
        .route("/api/health", get(|| async { Json(serde_json::json!({ "ok": true, "app": "backdrop" })) }))
        .route("/api/items", get(list_items))
        .route("/api/upload", post(upload).layer(DefaultBodyLimit::disable()))
        .route("/api/items/{id}", get(get_item).patch(patch_item).delete(delete_item))
        .route("/api/items/{id}/file", get(item_file))
        .route(
            "/api/items/{id}/thumb",
            get(item_thumb).put(put_thumb).layer(DefaultBodyLimit::max(8 << 20)),
        )
        .route("/downloads", get(list_downloads))
        .route("/downloads/{name}", get(download_release))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    tracing::info!("listening on {addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("serve");
}

async fn list_items(State(s): State<Shared>) -> Json<Vec<Listed>> {
    let mut items: Vec<Listed> = s
        .items
        .read()
        .await
        .values()
        .map(|i| Listed { item: i.clone(), thumb: s.item_dir(&i.id).join("thumb.jpg").is_file() })
        .collect();
    items.sort_by(|a, b| b.item.added.cmp(&a.item.added));
    Json(items)
}

async fn get_item(State(s): State<Shared>, Path(id): Path<String>) -> Response {
    match s.items.read().await.get(&id) {
        Some(item) => Json(item.clone()).into_response(),
        None => err(StatusCode::NOT_FOUND, "no such item"),
    }
}

#[derive(Deserialize)]
struct UploadQuery {
    /// Original file name; its extension decides the kind.
    filename: String,
    name: Option<String>,
}

async fn upload(State(s): State<Shared>, Query(q): Query<UploadQuery>, req: Request) -> Response {
    let ext = std::path::Path::new(&q.filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let Some(kind) = common::kind_for_ext(&ext) else {
        return err(StatusCode::BAD_REQUEST, format!("unsupported file type .{ext}"));
    };

    let n = s.tmp_counter.fetch_add(1, Ordering::Relaxed);
    let tmp = s.dir.join("tmp").join(format!("{}-{n}.{ext}", std::process::id()));
    let result = async {
        let mut file = tokio::fs::File::create(&tmp).await?;
        let mut hasher = Sha256::new();
        let mut size = 0u64;
        let mut stream = req.into_body().into_data_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(std::io::Error::other)?;
            hasher.update(&chunk);
            size += chunk.len() as u64;
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        Ok::<_, std::io::Error>((common::id_from_digest(&hasher.finalize()), size))
    }
    .await;
    let (mut id, mut size) = match result {
        Ok(v) => v,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return err(StatusCode::BAD_REQUEST, format!("upload failed: {e}"));
        }
    };
    if size == 0 {
        let _ = tokio::fs::remove_file(&tmp).await;
        return err(StatusCode::BAD_REQUEST, "empty file");
    }

    // A bare .html upload (from the web page) is wrapped into a zip so every web item looks the same.
    let mut tmp = tmp;
    if kind == Kind::Web && ext != "zip" {
        let zipped = tmp.with_extension("zip");
        let (src, dst) = (tmp.clone(), zipped.clone());
        let wrapped = tokio::task::spawn_blocking(move || {
            common::pack::zip_html(&src, &dst)?;
            let size = std::fs::metadata(&dst)?.len();
            Ok::<_, std::io::Error>((common::hash_file(&dst)?, size))
        })
        .await
        .expect("join");
        let _ = tokio::fs::remove_file(&tmp).await;
        match wrapped {
            Ok((new_id, new_size)) => {
                id = new_id;
                size = new_size;
                tmp = zipped;
            }
            Err(e) => return err(StatusCode::BAD_REQUEST, format!("could not pack html: {e}")),
        }
    } else if kind == Kind::Web {
        let check = tmp.clone();
        let ok = tokio::task::spawn_blocking(move || {
            let dir = check.with_extension("check");
            let r = common::pack::extract(&check, &dir);
            let _ = std::fs::remove_dir_all(&dir);
            r
        })
        .await
        .expect("join");
        if let Err(e) = ok {
            let _ = tokio::fs::remove_file(&tmp).await;
            return err(StatusCode::BAD_REQUEST, format!("not a web wallpaper: {e}"));
        }
    }

    if let Some(existing) = s.items.read().await.get(&id).cloned() {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Json(existing).into_response();
    }

    let dir = s.item_dir(&id);
    let file = common::stored_name(kind, &ext);
    if let Err(e) = async {
        tokio::fs::create_dir_all(&dir).await?;
        tokio::fs::rename(&tmp, dir.join(&file)).await
    }
    .await
    {
        let _ = tokio::fs::remove_file(&tmp).await;
        return err(StatusCode::INTERNAL_SERVER_ERROR, format!("store failed: {e}"));
    }

    let media = dir.join(&file);
    let (width, height) = if kind == Kind::Web { (None, None) } else { probe_size(&media).await };
    let item = Item {
        id: id.clone(),
        name: q
            .name
            .filter(|n| !n.trim().is_empty())
            .map(|n| n.trim().to_string())
            .unwrap_or_else(|| common::name_from_file(&q.filename)),
        kind,
        file,
        size,
        width,
        height,
        added: common::now(),
        tags: vec![],
    };
    if let Err(e) = s.save_meta(&item).await {
        return err(StatusCode::INTERNAL_SERVER_ERROR, format!("meta write failed: {e}"));
    }
    if kind != Kind::Web {
        make_thumb(&media, &dir.join("thumb.jpg")).await;
    }
    tracing::info!("added {id} {:?} \"{}\" ({size} bytes)", kind, item.name);
    s.items.write().await.insert(id, item.clone());
    (StatusCode::CREATED, Json(item)).into_response()
}

async fn probe_size(path: &std::path::Path) -> (Option<u32>, Option<u32>) {
    let out = tokio::process::Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x"])
        .arg(path)
        .output()
        .await;
    let Ok(out) = out else { return (None, None) };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.trim().lines().next().unwrap_or("").split('x');
    let w = parts.next().and_then(|v| v.trim().parse().ok());
    let h = parts.next().and_then(|v| v.trim().parse().ok());
    (w, h)
}

/// Grabs a frame 1 s in (or the first frame, for short clips and images) as a 480 px wide JPEG.
async fn make_thumb(media: &std::path::Path, out: &std::path::Path) {
    for seek in [Some("1"), None] {
        let mut cmd = tokio::process::Command::new("ffmpeg");
        cmd.args(["-v", "error", "-y"]);
        if let Some(t) = seek {
            cmd.args(["-ss", t]);
        }
        cmd.arg("-i").arg(media).args(["-frames:v", "1", "-vf", "scale=480:-2,format=yuvj420p", "-q:v", "4"]).arg(out);
        cmd.stderr(std::process::Stdio::null());
        if let Ok(status) = cmd.status().await {
            if status.success() && out.metadata().map(|m| m.len() > 0).unwrap_or(false) {
                return;
            }
        }
    }
    tracing::warn!("no thumbnail for {}", media.display());
}

#[derive(Deserialize)]
struct Patch {
    name: Option<String>,
    tags: Option<Vec<String>>,
}

async fn patch_item(State(s): State<Shared>, Path(id): Path<String>, Json(p): Json<Patch>) -> Response {
    let mut items = s.items.write().await;
    let Some(item) = items.get_mut(&id) else {
        return err(StatusCode::NOT_FOUND, "no such item");
    };
    if let Some(name) = p.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
        item.name = name;
    }
    if let Some(tags) = p.tags {
        item.tags = tags.into_iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
    }
    let item = item.clone();
    drop(items);
    if let Err(e) = s.save_meta(&item).await {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    Json(item).into_response()
}

async fn delete_item(State(s): State<Shared>, Path(id): Path<String>) -> Response {
    if !common::valid_id(&id) || s.items.write().await.remove(&id).is_none() {
        return err(StatusCode::NOT_FOUND, "no such item");
    }
    let _ = tokio::fs::remove_dir_all(s.item_dir(&id)).await;
    tracing::info!("deleted {id}");
    StatusCode::NO_CONTENT.into_response()
}

async fn serve(path: PathBuf, req: Request) -> Response {
    match ServeFile::new(path).oneshot(req).await {
        Ok(r) => r.map(Body::new),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn item_file(State(s): State<Shared>, Path(id): Path<String>, req: Request) -> Response {
    let Some(file) = s.items.read().await.get(&id).map(|i| i.file.clone()) else {
        return err(StatusCode::NOT_FOUND, "no such item");
    };
    serve(s.item_dir(&id).join(file), req).await
}

async fn item_thumb(State(s): State<Shared>, Path(id): Path<String>, req: Request) -> Response {
    if !s.items.read().await.contains_key(&id) {
        return err(StatusCode::NOT_FOUND, "no such item");
    }
    let mut res = serve(s.item_dir(&id).join("thumb.jpg"), req).await;
    res.headers_mut().insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());
    res
}

async fn put_thumb(State(s): State<Shared>, Path(id): Path<String>, body: axum::body::Bytes) -> Response {
    if !s.items.read().await.contains_key(&id) {
        return err(StatusCode::NOT_FOUND, "no such item");
    }
    if body.len() < 3 || body[..3] != [0xFF, 0xD8, 0xFF] {
        return err(StatusCode::BAD_REQUEST, "thumbnail must be a JPEG");
    }
    match tokio::fs::write(s.item_dir(&id).join("thumb.jpg"), &body).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

fn release_name_ok(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\']) && !name.contains("..")
}

async fn list_downloads(State(s): State<Shared>) -> Json<Vec<serde_json::Value>> {
    let mut out = vec![];
    if let Ok(mut rd) = tokio::fs::read_dir(s.dir.join("releases")).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            let name = e.file_name().to_string_lossy().to_string();
            if !release_name_ok(&name) {
                continue;
            }
            if let Ok(m) = e.metadata().await {
                if m.is_file() {
                    let modified = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    out.push(serde_json::json!({ "name": name, "size": m.len(), "modified": modified }));
                }
            }
        }
    }
    out.sort_by(|a, b| b["modified"].as_u64().cmp(&a["modified"].as_u64()));
    Json(out)
}

async fn download_release(State(s): State<Shared>, Path(name): Path<String>, req: Request) -> Response {
    if !release_name_ok(&name) {
        return err(StatusCode::NOT_FOUND, "not found");
    }
    let mut res = serve(s.dir.join("releases").join(&name), req).await;
    if res.status().is_success() {
        let disp = format!("attachment; filename=\"{}\"", name.replace('"', ""));
        res.headers_mut().insert(header::CONTENT_DISPOSITION, disp.parse().unwrap());
    }
    res
}
