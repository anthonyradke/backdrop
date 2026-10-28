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
            _ => format!("{}/{}", item.id, item.file),
        }
    }

    pub fn media_path(&self, item: &Item) -> PathBuf {
        self.dir(&item.id).join(&item.file)
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
    let tmp = dir.join("meta.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(item).expect("item serializes"))?;
    std::fs::rename(&tmp, dir.join("meta.json"))
}

fn other<E: std::fmt::Display>(e: E) -> io::Error {
    io::Error::other(e.to_string())
}

/// Copies a file or wallpaper folder into the library. Blocking; the caller adds the result to the map.
/// Returns the existing item untouched if the same content is already there.
pub fn import(root: &Path, src: &Path, existing: &HashMap<String, Item>) -> io::Result<Item> {
    import_inner(root, src, existing, false)
}

/// Like `import`, but hard-links a single file instead of copying it when it's on the same drive.
/// Used for Steam downloads, which Steam replaces rather than edits.
pub fn import_linked(root: &Path, src: &Path, existing: &HashMap<String, Item>) -> io::Result<Item> {
    import_inner(root, src, existing, true)
}

fn import_inner(root: &Path, src: &Path, existing: &HashMap<String, Item>, link: bool) -> io::Result<Item> {
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
        if source.starts_with(&staging) {
            std::fs::rename(&source, dir.join(&file))?;
        } else if !(link && std::fs::hard_link(&source, dir.join(&file)).is_ok()) {
            std::fs::copy(&source, dir.join(&file))?;
        }
        if kind == Kind::Web {
            common::pack::extract(&dir.join(&file), &dir.join("web")).map_err(|e| {
                let _ = std::fs::remove_dir_all(&dir);
                other(format!("{file_name}: {e}"))
            })?;
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
        };
        write_meta(&dir, &item)?;
        Ok(item)
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
        let reopened = Library::open(root);
        assert_eq!(reopened.items.len(), 3);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
