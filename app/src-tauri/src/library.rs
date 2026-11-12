//! The local library: `<app data>/library/<id>/` holding `meta.json`, the media file, `thumb.jpg`
//! and `poster.jpg` (the larger frame the library's hero shows).
//! Web wallpapers also keep their zip extracted in `web/`.

use crate::common::{self, Item, Kind};
use serde::Serialize;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

pub struct Library {
    pub root: PathBuf,
    pub items: HashMap<String, Item>,
}

#[derive(Serialize, Clone)]
pub struct ItemView {
    #[serde(flatten)]
    pub item: Item,
    pub thumb: bool,
    pub poster: bool,
}

impl Library {
    pub fn open(root: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&root);
        let mut items = HashMap::new();
        if let Ok(rd) = std::fs::read_dir(&root) {
            for e in rd.flatten() {
                // Staging folders left by an import that was cut short.
                if e.file_name().to_string_lossy().starts_with(".import-") {
                    let _ = std::fs::remove_dir_all(e.path()).or_else(|_| std::fs::remove_file(e.path()));
                    continue;
                }
                let meta = e.path().join("meta.json");
                if let Ok(Ok(item)) = std::fs::read(&meta).map(|b| serde_json::from_slice::<Item>(&b)) {
                    if common::valid_id(&item.id) && e.path().join(&item.file).is_file() {
                        items.insert(item.id.clone(), item);
                    }
                }
            }
        }
        Self { root, items }
    }

    pub fn dir(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    /// The path relative to the library root that the player loads (`<id>/media.mp4`, `<id>/web/index.html`).
    pub fn player_src(item: &Item) -> String {
        match item.kind {
            Kind::Web => format!("{}/web/index.html", item.id),
            Kind::Scene => format!("{}/{}/", item.id, crate::scene::DIR),
            _ => format!("{}/{}", item.id, item.file),
        }
    }

    pub fn has_thumb(&self, id: &str) -> bool {
        self.dir(id).join("thumb.jpg").is_file()
    }

    pub fn views(&self) -> Vec<ItemView> {
        let mut v: Vec<ItemView> = self
            .items
            .values()
            .map(|i| ItemView {
                item: i.clone(),
                thumb: self.has_thumb(&i.id),
                poster: self.dir(&i.id).join("poster.jpg").is_file(),
            })
            .collect();
        v.sort_by(|a, b| b.item.added.cmp(&a.item.added).then(a.item.name.cmp(&b.item.name)));
        v
    }

    pub fn save_meta(&self, item: &Item) -> io::Result<()> {
        write_meta(&self.dir(&item.id), item)
    }

    pub fn remove(&mut self, id: &str) {
        if common::valid_id(id) && self.items.remove(id).is_some() {
            let _ = std::fs::remove_dir_all(self.dir(id));
        }
    }
}

pub fn write_meta(dir: &Path, item: &Item) -> io::Result<()> {
    common::write_atomic(&dir.join("meta.json"), &serde_json::to_vec_pretty(item).expect("item serializes"))
}

fn other<E: std::fmt::Display>(e: E) -> io::Error {
    io::Error::other(e.to_string())
}

/// Imports into the library and adds the item to it. Blocking. One import runs at a time: two of
/// the same content at once (a drop while the workshop sync imports it, say) would each clear the
/// folder the other is writing. `finish` can adjust the new item before it's added.
pub fn import_into(core: &crate::Core, src: &Path, link: bool, finish: impl FnOnce(&mut Item, &Path)) -> io::Result<Item> {
    let _one_at_a_time = core.import_lock.lock().unwrap();
    let (root, existing) = {
        let lib = core.library.lock().unwrap();
        (lib.root.clone(), lib.items.clone())
    };
    let mut item = import_inner(&root, src, &existing, link)?;
    if existing.contains_key(&item.id) {
        // Already there (or deleted meanwhile, in which case it stays deleted).
        return Ok(item);
    }
    let dir = root.join(&item.id);
    finish(&mut item, &dir);
    core.library.lock().unwrap().items.insert(item.id.clone(), item.clone());
    Ok(item)
}

/// Copies a file or wallpaper folder into the library. Blocking; the caller adds the result to the map.
/// Returns the existing item untouched if the same content is already there.
#[cfg(test)]
pub fn import(root: &Path, src: &Path, existing: &HashMap<String, Item>) -> io::Result<Item> {
    import_inner(root, src, existing, false)
}

fn import_inner(root: &Path, src: &Path, existing: &HashMap<String, Item>, link: bool) -> io::Result<Item> {
    if crate::scene::is_scene(src) {
        return crate::scene::import(root, src, existing);
    }
    let file_name = src.file_name().and_then(|n| n.to_str()).unwrap_or("wallpaper").to_string();
    let staging = root.join(format!(".import-{}-{}", std::process::id(), common::now()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    let result = (|| {
        // Work out what we're storing and where the bytes to hash live.
        let (kind, ext, source): (Kind, String, PathBuf) = if src.is_dir() {
            let zip = staging.join("wallpaper.zip");
            common::pack::zip_dir(src, &zip)?;
            (Kind::Web, "zip".into(), zip)
        } else {
            let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            let kind = common::kind_for_ext(&ext)
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("{file_name}: unsupported file type")))?;
            if kind == Kind::Web && ext != "zip" {
                let zip = staging.join("wallpaper.zip");
                common::pack::zip_html(src, &zip)?;
                (Kind::Web, "zip".into(), zip)
            } else {
                (kind, ext, src.to_path_buf())
            }
        };

        let id = common::hash_file(&source)?;
        if let Some(item) = existing.get(&id) {
            return Ok(item.clone());
        }
        let file = common::stored_name(kind, &ext);
        let dir = root.join(&id);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        // Anything that fails from here on takes the half-made folder with it.
        let made = (|| {
            if source.starts_with(&staging) {
                std::fs::rename(&source, dir.join(&file))?;
            } else if !(link && std::fs::hard_link(&source, dir.join(&file)).is_ok()) {
                std::fs::copy(&source, dir.join(&file))?;
            }
            if kind == Kind::Web {
                common::pack::extract(&dir.join(&file), &dir.join("web")).map_err(|e| other(format!("{file_name}: {e}")))?;
            }
            let stored = dir.join(&file);
            let item = Item {
                id: id.clone(),
                name: if src.is_dir() { file_name.clone() } else { common::name_from_file(&file_name) },
                kind,
                size: std::fs::metadata(&stored)?.len(),
                codec: if kind == Kind::Video { common::mp4_codec(&stored) } else { None },
                fps: None,
                file,
                width: None,
                height: None,
                added: common::now(),
                tags: vec![],
                workshop: None,
                preview: None,
                ..Default::default()
            };
            write_meta(&dir, &item)?;
            Ok(item)
        })();
        if made.is_err() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        made
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_file_html_and_folder() {
        let tmp = std::env::temp_dir().join(format!("backdrop-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        std::fs::create_dir_all(src.join("site/js")).unwrap();
        std::fs::write(src.join("clip_one.mp4"), b"not really a video").unwrap();
        std::fs::write(src.join("page.html"), b"<h1>hi</h1>").unwrap();
        std::fs::write(src.join("site/index.html"), b"<script src=js/a.js></script>").unwrap();
        std::fs::write(src.join("site/js/a.js"), b"1").unwrap();
        let root = tmp.join("lib");
        let mut lib = Library::open(root.clone());

        let v = import(&root, &src.join("clip_one.mp4"), &lib.items).unwrap();
        assert_eq!((v.kind, v.file.as_str(), v.name.as_str()), (Kind::Video, "media.mp4", "clip one"));
        lib.items.insert(v.id.clone(), v.clone());
        let again = import(&root, &src.join("clip_one.mp4"), &lib.items).unwrap();
        assert_eq!(again.id, v.id);

        let h = import(&root, &src.join("page.html"), &lib.items).unwrap();
        assert_eq!(h.kind, Kind::Web);
        assert!(root.join(&h.id).join("web/index.html").is_file());

        let f = import(&root, &src.join("site"), &lib.items).unwrap();
        assert!(root.join(&f.id).join("web/js/a.js").is_file());
        assert_eq!(f.name, "site");

        assert!(import(&root, &src.join("nope.exe"), &lib.items).is_err());
        // A zip without a page fails, and leaves no folder behind.
        let before = std::fs::read_dir(&root).unwrap().count();
        std::fs::write(src.join("empty.zip"), b"PK\x05\x06\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0").unwrap();
        assert!(import(&root, &src.join("empty.zip"), &lib.items).is_err());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), before);
        // Staging left by an import that was cut short goes on the next start.
        std::fs::create_dir_all(root.join(".import-1-2").join("x")).unwrap();
        let reopened = Library::open(root.clone());
        assert_eq!(reopened.items.len(), 3);
        assert!(!root.join(".import-1-2").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
