//! The Steam Workshop for Wallpaper Engine (app 431960): browsing it, and taking the video, HTML
//! and scene wallpapers Steam downloads into the library.
//!
//! Workshop files can't be downloaded without owning Wallpaper Engine, so Backdrop leaves that to
//! Steam: "Download" asks the Steam client to subscribe in the background (`steamapi`, the way
//! Wallpaper Engine does it), or opens the item in Steam if that can't work. Steam downloads it into
//! `steamapps/workshop/content/431960/<id>/`, and the sync loop here imports it once it shows up.
//! Wallpaper Engine has to stay installed in Steam for that (it doesn't have to run).
//!
//! Browsing scrapes the public workshop page for ids (the QueryFiles API needs a key) and gets the
//! details from `GetPublishedFileDetails`, which doesn't. HTTP goes through `curl`, which ships with
//! Windows 10 and later, so there's no TLS stack to build in.
//!
//! No anime. Steam's tags alone don't do it (lots of anime is tagged Music, Cartoon, Relaxing...),
//! so there are three layers: the browse query only asks for the "Everyone" rating and excludes
//! every genre that turned out to be mostly anime when sampled (2026-10-25); `allowed` drops items
//! without one of the remaining `GENRES` or with an anime word in the title or description; and the
//! user can hide single items or everything by a creator (`Store`).

use crate::common::{self, Item, Kind};
use crate::{library, log, Core};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub const APP_ID: u32 = 431960;

/// Genres that were mostly free of anime when sampled.
pub const GENRES: &[&str] = &[
    "Nature", "Landscape", "Sci-Fi", "Vehicle", "Cyberpunk", "Fantasy", "Pixel art", "Retro", "Medieval", "Technology",
];
/// Everything else Wallpaper Engine tags with. Anime, Girls, Guys and MMD are anime by name; Game,
/// Unspecified, Music, Cartoon, Animal, CGI and Relaxing were mostly anime; Abstract and Memes mostly
/// memes; Sports and Television weren't checked.
const EXCLUDED: &[&str] = &[
    "Anime", "Girls", "Guys", "MMD", "Game", "Unspecified", "Music", "Cartoon", "Animal", "CGI", "Relaxing", "Abstract",
    "Memes", "Sports", "Television", "Questionable", "Mature",
];
/// Words that give anime away in a title or description (lowercase; Chinese and Japanese too,
/// since most of the workshop is). Checked as substrings, so they're long enough not to hit
/// ordinary words.
const ANIME_WORDS: &[&str] = &[
    "anime", "waifu", "chibi", "kawaii", "manga", "otaku", "hentai", "loli", "senpai", "vtuber", "hololive", "ghibli",
    "shinkai", "genshin", "honkai", "star rail", "zenless", "wuthering", "arknights", "blue archive", "azur lane",
    "nikke", "naruto", "one piece", "demon slayer", "kimetsu", "jujutsu", "evangelion", "chainsaw man", "attack on titan",
    "dragon ball", "pokemon", "pokémon", "sailor moon", "miku", "touhou", "frieren", "your name", "kimi no na wa",
    "lycoris", "bocchi", "re:zero", "konosuba", "edgerunners", "studio trigger", "kill la kill", "gurren", "spy x family",
    "jojo", "hunter x hunter", "my hero academia", "tokyo ghoul", "sword art online", "ghost in the shell", "persona 5",
    "solo leveling", "oshi no ko", "dandadan", "spirited away", "totoro", "gojo", "sukuna", "luffy", "girl", "neko", "二次元", "动漫", "番剧", "少女", "萌", "原神", "崩坏",
    "星穹", "鸣潮", "鳴潮", "明日方舟", "绝区零", "碧蓝", "初音", "老婆", "アニメ", "美少女", "萌え", "初音ミク",
];

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Sort {
    #[default]
    Week,
    Month,
    Year,
    AllTime,
    Newest,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Query {
    pub sort: Sort,
    /// One of `GENRES`, or empty for all of them.
    pub genre: String,
    /// None for every kind Backdrop plays.
    pub kind: Option<WsKind>,
    pub search: String,
    /// 1-based.
    pub page: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
#[serde(rename_all = "lowercase")]
pub enum WsKind {
    #[default]
    Video,
    Web,
    Scene,
}

impl WsKind {
    fn tag(self) -> &'static str {
        match self {
            WsKind::Video => "Video",
            WsKind::Web => "Web",
            WsKind::Scene => "Scene",
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WsItem {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub kind: WsKind,
    pub genres: Vec<String>,
    /// The resolution tag, e.g. "3840 x 2160".
    pub resolution: Option<String>,
    pub size: u64,
    pub subscriptions: u64,
    pub description: String,
    /// SteamID64 of whoever uploaded it.
    pub creator: String,
}

#[derive(Serialize)]
pub struct Page {
    pub items: Vec<WsItem>,
    pub more: bool,
}

// ---------- HTTP ----------

fn curl(args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = std::process::Command::new("curl");
    cmd.args(["-sSfL", "--max-time", "25", "-A", "Backdrop"]).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| format!("couldn't run curl: {e}"))?;
    if !out.status.success() {
        return Err(format!("Steam didn't answer ({})", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(out.stdout)
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn browse_url(q: &Query) -> String {
    let (sort, days) = match q.sort {
        Sort::Week => ("trend", Some(7)),
        Sort::Month => ("trend", Some(30)),
        Sort::Year => ("trend", Some(365)),
        Sort::AllTime => ("totaluniquesubscribers", None),
        Sort::Newest => ("mostrecent", None),
    };
    let mut url = format!(
        "https://steamcommunity.com/workshop/browse/?appid={APP_ID}&section=readytouseitems&numperpage=30&browsesort={sort}&actualsort={sort}&p={}",
        q.page.max(1)
    );
    if let Some(d) = days {
        url += &format!("&days={d}");
    }
    let mut required: Vec<&str> = q.kind.map(WsKind::tag).into_iter().chain(["Everyone"]).collect();
    if GENRES.contains(&q.genre.as_str()) {
        required.push(&q.genre);
    }
    for t in required {
        url += &format!("&requiredtags%5B%5D={}", enc(t));
    }
    for t in EXCLUDED {
        url += &format!("&excludedtags%5B%5D={}", enc(t));
    }
    let search = q.search.trim();
    if !search.is_empty() {
        url += &format!("&searchtext={}", enc(search));
    }
    url
}

/// Item ids in page order, from the `filedetails/?id=` links.
pub fn ids_in_page(html: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = vec![];
    for part in html.split("filedetails/?id=").skip(1) {
        let id: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !id.is_empty() && seen.insert(id.clone()) {
            out.push(id);
        }
    }
    out
}

#[derive(Deserialize)]
struct Details {
    response: DetailsResponse,
}
#[derive(Deserialize)]
struct DetailsResponse {
    #[serde(default)]
    publishedfiledetails: Vec<Detail>,
}
#[derive(Deserialize)]
struct Detail {
    publishedfileid: String,
    #[serde(default)]
    result: i32,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    preview_url: String,
    #[serde(default)]
    file_size: serde_json::Value,
    #[serde(default)]
    subscriptions: u64,
    #[serde(default)]
    banned: i32,
    #[serde(default)]
    consumer_app_id: u32,
    #[serde(default)]
    creator: String,
    #[serde(default)]
    tags: Vec<Tag>,
}
#[derive(Deserialize)]
struct Tag {
    tag: String,
}

fn details(ids: &[String]) -> Result<Vec<Detail>, String> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let mut body = format!("itemcount={}", ids.len());
    for (i, id) in ids.iter().enumerate() {
        body += &format!("&publishedfileids%5B{i}%5D={id}");
    }
    let raw = curl(&[
        "--data-raw",
        &body,
        "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
    ])?;
    let d: Details = serde_json::from_slice(&raw).map_err(|e| format!("odd answer from Steam: {e}"))?;
    Ok(d.response.publishedfiledetails)
}

fn looks_anime(text: &str) -> bool {
    let t = text.to_lowercase();
    ANIME_WORDS.iter().any(|w| t.contains(w))
}

/// Turns a workshop entry into a browse item, or None if it's not something Backdrop shows: not
/// Wallpaper Engine, banned, not video/HTML/scene, rated above Everyone, not in one of `GENRES`, or with
/// an anime word in it.
fn kind_of(tags: &[&str]) -> Option<WsKind> {
    if tags.contains(&"Video") {
        Some(WsKind::Video)
    } else if tags.contains(&"Web") {
        Some(WsKind::Web)
    } else if tags.contains(&"Scene") {
        Some(WsKind::Scene)
    } else {
        None
    }
}

fn file_size(d: &Detail) -> u64 {
    match &d.file_size {
        serde_json::Value::String(s) => s.parse().unwrap_or(0),
        v => v.as_u64().unwrap_or(0),
    }
}

/// Details of an item Steam downloaded, whatever it's tagged.
fn described(d: Detail) -> Option<WsItem> {
    let tags: Vec<&str> = d.tags.iter().map(|t| t.tag.as_str()).collect();
    if d.result != 1 {
        return None;
    }
    let kind = kind_of(&tags)?;
    let genres = tags.iter().filter(|t| GENRES.contains(t)).map(|t| t.to_string()).collect();
    let size = file_size(&d);
    Some(WsItem {
        resolution: tags.iter().find(|t| t.contains(" x ")).map(|t| t.to_string()),
        id: d.publishedfileid,
        title: d.title,
        preview: d.preview_url,
        kind,
        genres,
        size,
        subscriptions: d.subscriptions,
        description: d.description.chars().take(600).collect(),
        creator: d.creator,
    })
}

fn local_details(l: Local) -> WsItem {
    WsItem {
        id: l.id,
        title: l.title,
        preview: String::new(),
        kind: l.kind,
        genres: vec![],
        resolution: None,
        size: 0,
        subscriptions: 0,
        description: String::new(),
        creator: String::new(),
    }
}

fn allowed(d: Detail) -> Option<WsItem> {
    let tags: Vec<&str> = d.tags.iter().map(|t| t.tag.as_str()).collect();
    if d.result != 1 || d.banned != 0 || d.consumer_app_id != APP_ID || tags.iter().any(|t| EXCLUDED.contains(t)) {
        return None;
    }
    let kind = kind_of(&tags)?;
    let genres: Vec<String> = tags.iter().filter(|t| GENRES.contains(t)).map(|t| t.to_string()).collect();
    if genres.is_empty() || !tags.contains(&"Everyone") || looks_anime(&d.title) || looks_anime(&d.description) {
        return None;
    }
    let size = file_size(&d);
    Some(WsItem {
        resolution: tags.iter().find(|t| t.contains(" x ")).map(|t| t.to_string()),
        id: d.publishedfileid,
        title: d.title,
        preview: d.preview_url,
        kind,
        genres,
        size,
        subscriptions: d.subscriptions,
        description: d.description.chars().take(600).collect(),
        creator: d.creator,
    })
}

/// One page of the workshop, without what the user hid. Blocking.
pub fn browse(q: &Query, hidden: &Hidden) -> Result<Page, String> {
    let html = curl(&[&browse_url(q)])?;
    let ids = ids_in_page(&String::from_utf8_lossy(&html));
    let more = ids.len() >= 30;
    let items = details(&ids)?.into_iter().filter_map(allowed).filter(|i| !hidden.hides(i)).collect();
    Ok(Page { items, more })
}

// ---------- Steam's download folder ----------

/// Every `steamapps/workshop/content/431960` folder, one per Steam library that has one.
pub fn content_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vec![];
    for lib in steam_libraries() {
        let dir = lib.join("steamapps").join("workshop").join("content").join(APP_ID.to_string());
        if dir.is_dir() && !out.iter().any(|d| same_dir(d, &dir)) {
            out.push(dir);
        }
    }
    out
}

/// Steam's own folder, then every library folder in `libraryfolders.vdf` (which usually lists
/// Steam's folder again).
pub fn steam_libraries() -> Vec<PathBuf> {
    let Some(steam) = crate::platform::steam_dir() else { return vec![] };
    let mut libs = vec![steam.clone()];
    if let Ok(vdf) = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf")) {
        libs.extend(library_paths(&vdf));
    }
    libs
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// The `"path"` values in `libraryfolders.vdf`.
pub fn library_paths(vdf: &str) -> Vec<PathBuf> {
    vdf.lines()
        .filter_map(|l| {
            let l = l.trim();
            let rest = l.strip_prefix("\"path\"")?.trim();
            let v = rest.strip_prefix('"')?.strip_suffix('"')?;
            Some(PathBuf::from(v.replace("\\\\", "\\")))
        })
        .collect()
}

/// A downloaded wallpaper's `project.json`, the parts we use.
#[derive(Deserialize)]
struct Project {
    #[serde(default)]
    title: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    file: String,
}

/// What Steam has downloaded for one item: the path to import (video file, or the folder for
/// HTML and scenes) and its title.
pub struct Local {
    pub id: String,
    pub src: PathBuf,
    pub title: String,
    pub kind: WsKind,
}

fn read_local(dir: &Path, id: &str) -> Option<Local> {
    let bytes = std::fs::read(dir.join("project.json")).ok()?;
    // Windows editors leave a byte order mark, which serde refuses.
    let p: Project = serde_json::from_str(String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}')).ok()?;
    let kind = p.kind.to_ascii_lowercase();
    // A scene's file is usually inside its package.
    if kind == "scene" {
        return Some(Local { id: id.into(), src: dir.to_path_buf(), title: p.title, kind: WsKind::Scene });
    }
    // Anyone can upload one, so `file` is checked before it's touched: an absolute path would read
    // outside the item, and on Windows a UNC path would connect to that host.
    let file = dir.join(common::safe_path(&p.file)?);
    if !file.is_file() {
        return None;
    }
    let (src, kind) = match kind.as_str() {
        "video" => (file, WsKind::Video),
        // The page's own folder, which may be a subfolder of the item.
        "web" if file.file_name()? == "index.html" => (file.parent()?.to_path_buf(), WsKind::Web),
        _ => return None,
    };
    Some(Local { id: id.into(), src, title: p.title, kind })
}

/// Every downloaded video/HTML/scene wallpaper Backdrop could play.
pub fn local_items() -> Vec<Local> {
    let mut out = vec![];
    for root in content_dirs() {
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        for e in rd.flatten() {
            let id = e.file_name().to_string_lossy().to_string();
            if id.bytes().all(|b| b.is_ascii_digit()) {
                if let Some(l) = read_local(&e.path(), &id) {
                    out.push(l);
                }
            }
        }
    }
    out
}

fn local_item(id: &str) -> Option<Local> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    content_dirs().into_iter().find_map(|root| read_local(&root.join(id), id))
}

/// Everything Steam has downloaded. These were subscribed to on purpose, so unlike browsing the
/// only filter is what the user hid. With no network, or for items Steam no longer knows about,
/// the title comes from the download itself.
pub fn subscribed(hidden: &Hidden) -> Result<Vec<WsItem>, String> {
    let locals = local_items();
    let ids: Vec<String> = locals.iter().map(|l| l.id.clone()).collect();
    let mut known: HashMap<String, WsItem> = HashMap::new();
    for chunk in ids.chunks(100) {
        let Ok(found) = details(chunk) else { break };
        known.extend(found.into_iter().filter_map(described).map(|i| (i.id.clone(), i)));
    }
    Ok(locals.into_iter().map(|l| known.remove(&l.id).unwrap_or_else(|| local_details(l))).filter(|i| !hidden.hides(i)).collect())
}

// ---------- importing ----------

/// Imports a downloaded workshop item into the library (hard-linked when it's on the same drive).
/// Blocking.
pub fn import(core: &Core, id: &str) -> Result<Item, String> {
    if let Some(item) = core.library.lock().unwrap().items.values().find(|i| i.workshop.as_deref() == Some(id)) {
        return Ok(item.clone());
    }
    let local = local_item(id).ok_or("Steam hasn't downloaded this one yet")?;
    let item = library::import_into(core, &local.src, true, |item, dir| {
        if !local.title.trim().is_empty() {
            item.name = local.title.trim().to_string();
        }
        item.workshop = Some(id.to_string());
        if item.kind == Kind::Web {
            // HTML wallpapers get no client thumbnail, so use Wallpaper Engine's preview if it's a JPEG.
            if let Some(prev) = std::fs::read_dir(&local.src).ok().and_then(|rd| {
                rd.flatten().map(|e| e.path()).find(|p| {
                    p.file_stem().is_some_and(|s| s == "preview")
                        && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg"))
                })
            }) {
                let _ = std::fs::copy(prev, dir.join("thumb.jpg"));
            }
        }
        if let Err(e) = library::write_meta(dir, item) {
            log(format!("workshop item {id}: couldn't save its details: {e}"));
        }
    })
    .map_err(|e| e.to_string())?;
    // The same file was already in the library, added by hand: it keeps its name, but now counts
    // as this workshop item.
    let item = if item.workshop.is_none() {
        let mut lib = core.library.lock().unwrap();
        match lib.items.get_mut(&item.id) {
            Some(known) => {
                known.workshop = Some(id.to_string());
                let known = known.clone();
                let _ = lib.save_meta(&known);
                known
            }
            None => item,
        }
    } else {
        item
    };
    core.emit_state();
    log(format!("imported workshop item {id} as {}", item.id));
    Ok(item)
}

/// What Backdrop remembers about the workshop, in `workshop.json` next to the config (so resetting
/// settings doesn't lose it): subscriptions still downloading, and what the user hid.
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Saved {
    /// Workshop ids subscribed from Backdrop that haven't landed in the library yet.
    pending: Vec<String>,
    #[serde(flatten)]
    hidden: Hidden,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct Hidden {
    pub items: Vec<String>,
    /// SteamID64s.
    pub creators: Vec<String>,
}

impl Hidden {
    fn hides(&self, i: &WsItem) -> bool {
        self.items.contains(&i.id) || (!i.creator.is_empty() && self.creators.contains(&i.creator))
    }
}

pub struct Store {
    path: PathBuf,
    saved: Saved,
}

impl Store {
    pub fn load(path: PathBuf) -> Self {
        let saved = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { path, saved }
    }

    fn save(&self) {
        let _ = std::fs::write(&self.path, serde_json::to_vec_pretty(&self.saved).expect("store serializes"));
    }

    pub fn pending(&self) -> &[String] {
        &self.saved.pending
    }

    pub fn hidden(&self) -> &Hidden {
        &self.saved.hidden
    }

    pub fn add_pending(&mut self, id: &str) {
        if !self.saved.pending.iter().any(|x| x == id) {
            self.saved.pending.push(id.to_string());
            self.save();
        }
    }

    pub fn remove_pending(&mut self, id: &str) {
        let n = self.saved.pending.len();
        self.saved.pending.retain(|x| x != id);
        if self.saved.pending.len() != n {
            self.save();
        }
    }

    /// Hides one item, or with `creator`, everything that creator uploaded.
    pub fn hide(&mut self, id: &str, creator: Option<&str>) {
        let (list, v) = match creator {
            Some(c) => (&mut self.saved.hidden.creators, c),
            None => (&mut self.saved.hidden.items, id),
        };
        if !list.iter().any(|x| x == v) {
            list.push(v.to_string());
        }
        self.saved.pending.retain(|x| x != id);
        self.save();
    }

    pub fn unhide_all(&mut self) {
        self.saved.hidden = Hidden::default();
        self.save();
    }
}

/// Every few seconds, imports pending subscriptions that Steam has finished downloading. Steam
/// downloads into `workshop/downloads` and only moves the folder into `content` when it's done.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        let core = app.state::<Core>();
        let ids = core.workshop.lock().unwrap().pending().to_vec();
        for id in ids {
            if local_item(&id).is_none() {
                continue;
            }
            if let Err(e) = import(&core, &id) {
                log(format!("workshop item {id}: {e}"));
            }
            // Either way, don't keep retrying the same item every few seconds.
            core.workshop.lock().unwrap().remove_pending(&id);
            core.emit_state();
        }
    });
}

/// Workshop id -> library item id, for the items that came from the workshop.
pub fn in_library(items: &HashMap<String, Item>) -> HashMap<String, String> {
    items.values().filter_map(|i| Some((i.workshop.clone()?, i.id.clone()))).collect()
}

/// Workshop item ids and SteamID64s are both plain numbers.
pub fn valid_ws_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_files_stay_in_the_item() {
        let dir = std::env::temp_dir().join(format!("backdrop-ws-local-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("site")).unwrap();
        std::fs::write(dir.join("a..b.mp4"), b"v").unwrap();
        std::fs::write(dir.join("site").join("index.html"), b"<p>").unwrap();
        let read = |kind: &str, file: &str| {
            let json = serde_json::json!({ "title": "t", "type": kind, "file": file });
            std::fs::write(dir.join("project.json"), json.to_string()).unwrap();
            read_local(&dir, "1").map(|l| l.src)
        };
        assert_eq!(read("video", "a..b.mp4"), Some(dir.join("a..b.mp4")));
        assert_eq!(read("web", "site/index.html"), Some(dir.join("site")));
        let outside = std::env::temp_dir().join(format!("backdrop-ws-outside-{}.mp4", std::process::id()));
        std::fs::write(&outside, b"v").unwrap();
        for bad in [outside.to_string_lossy().to_string(), r"\\host\share\a.mp4".into(), "../a..b.mp4".into(), "".into()] {
            assert_eq!(read("video", &bad), None, "{bad}");
        }
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn url_excludes_anime_and_asks_for_everyone() {
        let q = Query { sort: Sort::Month, genre: "Sci-Fi".into(), kind: Some(WsKind::Video), search: "neon city".into(), page: 2 };
        let url = browse_url(&q);
        for t in ["requiredtags%5B%5D=Video", "requiredtags%5B%5D=Everyone", "requiredtags%5B%5D=Sci-Fi", "excludedtags%5B%5D=Anime", "days=30", "p=2", "searchtext=neon%20city"] {
            assert!(url.contains(t), "{t} missing from {url}");
        }
        assert!(!browse_url(&Query { genre: "Anime".into(), ..Default::default() }).contains("requiredtags%5B%5D=Anime"));
        // Without a kind every type comes back; `allowed` drops what Backdrop can't play.
        let all = browse_url(&Query::default());
        assert!(!["Video", "Web", "Scene"].iter().any(|t| all.contains(&format!("requiredtags%5B%5D={t}"))));
        assert!(browse_url(&Query { kind: Some(WsKind::Scene), ..Default::default() }).contains("requiredtags%5B%5D=Scene"));
    }

    #[test]
    fn ids_come_out_in_order_once() {
        let html = r#"<a href="https://steamcommunity.com/sharedfiles/filedetails/?id=22&searchtext="><a href="filedetails/?id=11">x filedetails/?id=22"#;
        assert_eq!(ids_in_page(html), vec!["22", "11"]);
    }

    fn detail(tags: &[&str]) -> Detail {
        Detail {
            publishedfileid: "1".into(),
            result: 1,
            title: "t".into(),
            description: String::new(),
            preview_url: String::new(),
            file_size: serde_json::json!("1234"),
            subscriptions: 0,
            banned: 0,
            consumer_app_id: APP_ID,
            creator: "7".into(),
            tags: tags.iter().map(|t| Tag { tag: t.to_string() }).collect(),
        }
    }

    #[test]
    fn filter_keeps_only_safe_genres() {
        let ok = allowed(detail(&["Video", "Nature", "Wallpaper", "3840 x 2160", "Everyone"])).unwrap();
        assert_eq!((ok.kind, ok.size, ok.resolution.as_deref()), (WsKind::Video, 1234, Some("3840 x 2160")));
        assert!(allowed(detail(&["Video", "Anime", "Everyone"])).is_none());
        assert!(allowed(detail(&["Video", "Nature", "Anime", "Everyone"])).is_none());
        assert!(allowed(detail(&["Video", "Wallpaper", "1920 x 1080", "Everyone"])).is_none());
        assert!(allowed(detail(&["Video", "Nature", "Mature"])).is_none());
        assert!(allowed(detail(&["Application", "Nature", "Everyone"])).is_none());
        assert_eq!(allowed(detail(&["Web", "Technology", "Everyone"])).unwrap().kind, WsKind::Web);
        assert_eq!(allowed(detail(&["Scene", "Technology", "Everyone"])).unwrap().kind, WsKind::Scene);
        // What's already downloaded isn't held to the browsing filter.
        assert_eq!(described(detail(&["Scene", "Anime", "Mature"])).unwrap().kind, WsKind::Scene);
        let mut d = detail(&["Video", "Nature", "Everyone"]);
        d.title = "Genshin Impact - Liyue Harbor".into();
        assert!(allowed(d).is_none());
        let mut d = detail(&["Video", "Landscape", "Everyone"]);
        d.description = "动漫风景".into();
        assert!(allowed(d).is_none());
    }

    #[test]
    fn hiding() {
        let path = std::env::temp_dir().join(format!("backdrop-ws-store-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut st = Store::load(path.clone());
        st.add_pending("5");
        st.hide("5", None);
        st.hide("6", Some("7"));
        let st = Store::load(path.clone());
        assert!(st.pending().is_empty());
        let item = allowed(detail(&["Video", "Nature", "Everyone"])).unwrap();
        assert!(st.hidden().hides(&item)); // creator 7
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn vdf_paths() {
        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t}\n}";
        assert_eq!(library_paths(vdf), vec![PathBuf::from("C:\\Program Files (x86)\\Steam"), PathBuf::from("D:\\SteamLibrary")]);
    }

    #[test]
    fn reads_downloaded_projects() {
        let tmp = std::env::temp_dir().join(format!("backdrop-ws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("1")).unwrap();
        std::fs::write(tmp.join("1/project.json"), r#"{"title":"Rain","type":"Video","file":"rain.mp4"}"#).unwrap();
        std::fs::write(tmp.join("1/rain.mp4"), b"x").unwrap();
        std::fs::create_dir_all(tmp.join("2")).unwrap();
        std::fs::write(tmp.join("2/project.json"), r#"{"title":"S","type":"scene","file":"scene.json"}"#).unwrap();
        std::fs::write(tmp.join("2/scene.json"), b"{}").unwrap();
        let l = read_local(&tmp.join("1"), "1").unwrap();
        assert_eq!((l.src, l.title.as_str()), (tmp.join("1/rain.mp4"), "Rain"));
        // Scenes keep their file inside scene.pkg, so it doesn't have to be there.
        let l = read_local(&tmp.join("2"), "2").unwrap();
        assert_eq!((l.src, l.kind), (tmp.join("2"), WsKind::Scene));
        std::fs::remove_file(tmp.join("2/scene.json")).unwrap();
        assert!(read_local(&tmp.join("2"), "2").is_some());
        // Executables aren't wallpapers Backdrop will run.
        std::fs::create_dir_all(tmp.join("3")).unwrap();
        std::fs::write(tmp.join("3/project.json"), r#"{"title":"A","type":"application","file":"a.exe"}"#).unwrap();
        std::fs::write(tmp.join("3/a.exe"), b"x").unwrap();
        assert!(read_local(&tmp.join("3"), "3").is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
