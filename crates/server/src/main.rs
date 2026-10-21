//! Backdrop library server: stores wallpapers on disk and serves them to the apps.
//!
//! Layout under the data dir:
//!   items/<id>/meta.json, items/<id>/media.<ext> or wallpaper.zip, items/<id>/thumb.jpg
//!   releases/   app installers, listed at /downloads
//!   tmp/        uploads and conversions in progress

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use backdrop_common::{self as common, Item, Kind, Listed};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::RwLock;
use tower::ServiceExt;
use tower_http::services::ServeFile;

struct AppState {
    dir: PathBuf,
    items: RwLock<HashMap<String, Item>>,
    tmp_counter: AtomicU64,
    jobs: RwLock<Vec<Job>>,
    /// One conversion at a time; ffmpeg already uses several cores.
    encoder: tokio::sync::Semaphore,
}

type Shared = Arc<AppState>;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "error": msg.into() }))).into_response()
}

impl AppState {
    fn tmp_path(&self, ext: &str) -> PathBuf {
        let n = self.tmp_counter.fetch_add(1, Ordering::Relaxed);
        self.dir.join("tmp").join(format!("{}-{n}.{ext}", std::process::id()))
    }

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
    let state = Arc::new(AppState {
        dir,
        items: RwLock::new(items),
        tmp_counter: AtomicU64::new(0),
        jobs: RwLock::new(vec![]),
        encoder: tokio::sync::Semaphore::new(1),
    });
    tokio::spawn(backfill(state.clone()));

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
        .route("/api/items/{id}/convert", post(convert))
        .route("/api/jobs", get(list_jobs))
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

    let tmp = s.tmp_path(&ext);
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

    let name = q
        .name
        .filter(|n| !n.trim().is_empty())
        .map(|n| n.trim().to_string())
        .unwrap_or_else(|| common::name_from_file(&q.filename));
    match store(&s, tmp, id, size, kind, &ext, name).await {
        Ok((item, true)) => (StatusCode::CREATED, Json(item)).into_response(),
        Ok((item, false)) => Json(item).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// Moves a finished temp file into the library as a new item, probing it and making a thumbnail.
/// Returns the existing item (and false) when the same content is already there.
async fn store(
    s: &AppState,
    tmp: PathBuf,
    id: String,
    size: u64,
    kind: Kind,
    ext: &str,
    name: String,
) -> Result<(Item, bool), String> {
    if let Some(existing) = s.items.read().await.get(&id).cloned() {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Ok((existing, false));
    }

    let dir = s.item_dir(&id);
    let file = common::stored_name(kind, ext);
    if let Err(e) = async {
        tokio::fs::create_dir_all(&dir).await?;
        tokio::fs::rename(&tmp, dir.join(&file)).await
    }
    .await
    {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("store failed: {e}"));
    }

    let media = dir.join(&file);
    let p = if kind == Kind::Web { Probe::default() } else { probe(&media).await };
    let item = Item {
        id: id.clone(),
        name,
        kind,
        file,
        size,
        width: p.width,
        height: p.height,
        codec: if kind == Kind::Video { p.codec } else { None },
        fps: if kind == Kind::Video { p.fps } else { None },
        added: common::now(),
        tags: vec![],
    };
    s.save_meta(&item).await.map_err(|e| format!("meta write failed: {e}"))?;
    if kind != Kind::Web {
        make_thumb(&media, &dir.join("thumb.jpg")).await;
    }
    tracing::info!("added {id} {:?} \"{}\" ({size} bytes)", kind, item.name);
    s.items.write().await.insert(id, item.clone());
    Ok((item, true))
}

#[derive(Default, Debug, PartialEq)]
struct Probe {
    width: Option<u32>,
    height: Option<u32>,
    codec: Option<String>,
    fps: Option<f64>,
    duration: Option<f64>,
    hdr: bool,
}

/// Reads ffprobe's JSON for the first video stream.
fn parse_probe(json: &[u8]) -> Probe {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(json) else { return Probe::default() };
    let st = &v["streams"][0];
    let fps = st["avg_frame_rate"]
        .as_str()
        .filter(|r| *r != "0/0")
        .or(st["r_frame_rate"].as_str())
        .and_then(|r| {
            let (a, b) = r.split_once('/').unwrap_or((r, "1"));
            let (a, b) = (a.parse::<f64>().ok()?, b.parse::<f64>().ok()?);
            (b > 0.0 && a > 0.0).then(|| (a / b * 100.0).round() / 100.0)
        })
        // Still images report 25 fps; only trust rates that look like real video.
        .filter(|f| *f < 1000.0);
    let duration = st["duration"]
        .as_str()
        .or(v["format"]["duration"].as_str())
        .and_then(|d| d.parse::<f64>().ok());
    Probe {
        width: st["width"].as_u64().map(|w| w as u32),
        height: st["height"].as_u64().map(|h| h as u32),
        codec: st["codec_name"].as_str().map(String::from),
        fps,
        duration,
        hdr: matches!(st["color_transfer"].as_str(), Some("smpte2084" | "arib-std-b67")),
    }
}

async fn probe(path: &std::path::Path) -> Probe {
    let out = tokio::process::Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "v:0", "-of", "json"])
        .args(["-show_entries", "stream=codec_name,width,height,avg_frame_rate,r_frame_rate,duration,color_transfer:format=duration"])
        .arg(path)
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => parse_probe(&o.stdout),
        _ => Probe::default(),
    }
}

/// Items stored before the server recorded codecs get probed once at startup.
async fn backfill(s: Shared) {
    let todo: Vec<Item> = s
        .items
        .read()
        .await
        .values()
        .filter(|i| i.kind == Kind::Video && i.codec.is_none())
        .cloned()
        .collect();
    for mut item in todo {
        let p = probe(&s.item_dir(&item.id).join(&item.file)).await;
        if p.codec.is_none() {
            continue;
        }
        item.codec = p.codec;
        item.fps = p.fps;
        item.width = item.width.or(p.width);
        item.height = item.height.or(p.height);
        if s.save_meta(&item).await.is_ok() {
            s.items.write().await.insert(item.id.clone(), item);
        }
    }
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: u64,
    /// The item being converted.
    source: String,
    /// What the copy will be, e.g. "H.264, 1080p, 30 fps".
    label: String,
    /// queued | running | done | error
    state: &'static str,
    /// 0.0 - 1.0
    progress: f64,
    /// The new item's id once done.
    result: Option<String>,
    error: Option<String>,
    started: i64,
}

#[derive(Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
struct ConvertReq {
    /// Shrinks the short side to this many pixels (1080 = 1080p), never enlarges.
    max_height: Option<u32>,
    /// Drops frames down to this rate, never adds any.
    max_fps: Option<u32>,
}

/// The ffmpeg arguments for an H.264 copy that every WebView can play, and its label.
fn convert_args(src: &std::path::Path, out: &std::path::Path, p: &Probe, req: &ConvertReq) -> (Vec<String>, String) {
    let mut filters: Vec<String> = vec![];
    let mut label = vec!["H.264".to_string()];
    if p.hdr {
        // H.264 here is SDR; without tone mapping HDR footage comes out grey and flat.
        filters.push(
            "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv"
                .into(),
        );
        label.push("SDR".into());
    }
    if let Some(n) = req.max_height.filter(|n| *n >= 144) {
        let short = match (p.width, p.height) {
            (Some(w), Some(h)) => Some(w.min(h)),
            _ => None,
        };
        if short.is_none_or(|s| s > n) {
            filters.push(format!(
                "scale='if(gt(iw,ih),-2,min(iw,{n}))':'if(gt(iw,ih),min(ih,{n}),-2)':flags=lanczos"
            ));
            label.push(format!("{n}p"));
        }
    }
    if let Some(n) = req.max_fps.filter(|n| *n >= 1) {
        if p.fps.is_none_or(|f| f > n as f64 + 0.5) {
            filters.push(format!("fps={n}"));
            label.push(format!("{n} fps"));
        }
    }
    filters.push("format=yuv420p".into());
    let mut args: Vec<String> = ["-nostdin", "-v", "error", "-y", "-i"].map(String::from).to_vec();
    args.push(src.to_string_lossy().into());
    args.extend(["-map", "0:v:0", "-map", "0:a:0?", "-vf"].map(String::from));
    args.push(filters.join(","));
    args.extend(
        [
            "-c:v", "libx264", "-preset", "faster", "-crf", "20", "-profile:v", "high", "-threads", "6",
            "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats",
        ]
        .map(String::from),
    );
    args.push(out.to_string_lossy().into());
    (args, label.join(", "))
}

async fn update_job(s: &AppState, id: u64, f: impl FnOnce(&mut Job)) {
    if let Some(j) = s.jobs.write().await.iter_mut().find(|j| j.id == id) {
        f(j);
    }
}

async fn list_jobs(State(s): State<Shared>) -> Json<Vec<Job>> {
    Json(s.jobs.read().await.clone())
}

/// Starts making an H.264 copy of a video (optionally smaller or at a lower frame rate). The copy
/// becomes a new item; poll /api/jobs for progress.
async fn convert(State(s): State<Shared>, Path(id): Path<String>, body: Option<Json<ConvertReq>>) -> Response {
    let req = body.map(|b| b.0).unwrap_or_default();
    let Some(item) = s.items.read().await.get(&id).cloned() else {
        return err(StatusCode::NOT_FOUND, "no such item");
    };
    if item.kind != Kind::Video {
        return err(StatusCode::BAD_REQUEST, "only videos can be converted");
    }
    let src = s.item_dir(&id).join(&item.file);
    let (_, label) = convert_args(&src, &src, &probe(&src).await, &req);
    let job = {
        let mut jobs = s.jobs.write().await;
        if let Some(j) = jobs.iter().find(|j| j.source == id && j.label == label && matches!(j.state, "queued" | "running")) {
            return (StatusCode::ACCEPTED, Json(j.clone())).into_response();
        }
        let job = Job {
            id: jobs.iter().map(|j| j.id).max().unwrap_or(0) + 1,
            source: id.clone(),
            label,
            state: "queued",
            progress: 0.0,
            result: None,
            error: None,
            started: common::now(),
        };
        jobs.push(job.clone());
        // Keep the list short: drop the oldest finished jobs.
        while jobs.len() > 30 {
            match jobs.iter().position(|j| matches!(j.state, "done" | "error")) {
                Some(i) => {
                    jobs.remove(i);
                }
                None => break,
            }
        }
        job
    };
    tokio::spawn(run_job(s.clone(), job.id, item, req));
    (StatusCode::ACCEPTED, Json(job)).into_response()
}

async fn run_job(s: Shared, job_id: u64, source: Item, req: ConvertReq) {
    let result = async {
        let _permit = s.encoder.acquire().await.map_err(|e| e.to_string())?;
        update_job(&s, job_id, |j| j.state = "running").await;
        let src = s.item_dir(&source.id).join(&source.file);
        let p = probe(&src).await;
        let out = s.tmp_path("mp4");
        let (args, label) = convert_args(&src, &out, &p, &req);
        tracing::info!("converting {} to {label}", source.id);
        let mut child = tokio::process::Command::new("ffmpeg")
            .args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("can't run ffmpeg: {e}"))?;
        let mut stderr = child.stderr.take().expect("piped");
        let errors = tokio::spawn(async move {
            let mut buf = String::new();
            let _ = tokio::io::AsyncReadExt::read_to_string(&mut stderr, &mut buf).await;
            buf
        });
        let mut lines = tokio::io::BufReader::new(child.stdout.take().expect("piped")).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // ffmpeg's "out_time_ms" is really microseconds, like out_time_us.
            let us = line.strip_prefix("out_time_us=").or(line.strip_prefix("out_time_ms="));
            if let (Some(us), Some(total)) = (us.and_then(|v| v.parse::<f64>().ok()), p.duration) {
                let pct = (us / 1e6 / total).clamp(0.0, 0.99);
                update_job(&s, job_id, |j| j.progress = pct).await;
            }
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        let errors = errors.await.unwrap_or_default();
        if !status.success() {
            let _ = tokio::fs::remove_file(&out).await;
            let last = errors.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("ffmpeg failed").to_string();
            return Err(last);
        }
        let hashed = out.clone();
        let (id, size) = tokio::task::spawn_blocking(move || {
            Ok::<_, std::io::Error>((common::hash_file(&hashed)?, std::fs::metadata(&hashed)?.len()))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        let name = format!("{} ({label})", source.name);
        store(&s, out, id, size, Kind::Video, "mp4", name).await.map(|(item, _)| item.id)
    }
    .await;
    match result {
        Ok(new_id) => {
            tracing::info!("converted {} -> {new_id}", source.id);
            update_job(&s, job_id, |j| {
                j.state = "done";
                j.progress = 1.0;
                j.result = Some(new_id);
            })
            .await;
        }
        Err(e) => {
            tracing::warn!("converting {} failed: {e}", source.id);
            update_job(&s, job_id, |j| {
                j.state = "error";
                j.error = Some(e);
            })
            .await;
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_json() {
        let p = parse_probe(br#"{"streams":[{"codec_name":"hevc","width":3840,"height":2160,"avg_frame_rate":"60000/1001","color_transfer":"smpte2084"}],"format":{"duration":"12.5"}}"#);
        assert_eq!(p.codec.as_deref(), Some("hevc"));
        assert_eq!((p.width, p.height, p.fps, p.duration, p.hdr), (Some(3840), Some(2160), Some(59.94), Some(12.5), true));
        assert_eq!(parse_probe(b"garbage"), Probe::default());
    }

    #[test]
    fn convert_plan() {
        let src = std::path::Path::new("in.mov");
        let out = std::path::Path::new("out.mp4");
        let p = Probe { width: Some(3840), height: Some(2160), fps: Some(60.0), codec: Some("hevc".into()), ..Default::default() };
        let (args, label) = convert_args(src, out, &p, &ConvertReq { max_height: Some(1080), max_fps: Some(30) });
        assert_eq!(label, "H.264, 1080p, 30 fps");
        let vf = &args[args.iter().position(|a| a == "-vf").unwrap() + 1];
        assert!(vf.contains("min(ih,1080)") && vf.contains("fps=30") && vf.ends_with("format=yuv420p"), "{vf}");
        // Never upscales or adds frames.
        let small = Probe { width: Some(1280), height: Some(720), fps: Some(24.0), ..Default::default() };
        let (args, label) = convert_args(src, out, &small, &ConvertReq { max_height: Some(1080), max_fps: Some(30) });
        assert_eq!(label, "H.264");
        assert!(args.contains(&"format=yuv420p".to_string()));
        let (_, label) = convert_args(src, out, &Probe { hdr: true, ..Default::default() }, &ConvertReq::default());
        assert_eq!(label, "H.264, SDR");
    }
}
