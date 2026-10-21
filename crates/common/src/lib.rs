//! Types shared by the app and the library server.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Video,
    Image,
    /// A zip with an `index.html` (HTML/canvas/WebGL wallpaper).
    Web,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    /// First 16 hex chars of the file's SHA-256, so the same file gets the same id on every machine.
    pub id: String,
    pub name: String,
    pub kind: Kind,
    /// File name inside the item folder, e.g. `media.mp4` or `wallpaper.zip`.
    pub file: String,
    pub size: u64,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    /// Unix seconds.
    pub added: i64,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// An item as the server lists it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Listed {
    #[serde(flatten)]
    pub item: Item,
    /// Whether the server has a thumbnail for it.
    #[serde(default)]
    pub thumb: bool,
}

pub const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "mov", "webm", "mkv"];
pub const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "heic"];
pub const WEB_EXTS: &[&str] = &["zip", "html", "htm"];

pub fn kind_for_ext(ext: &str) -> Option<Kind> {
    let ext = ext.to_ascii_lowercase();
    if VIDEO_EXTS.contains(&ext.as_str()) {
        Some(Kind::Video)
    } else if IMAGE_EXTS.contains(&ext.as_str()) {
        Some(Kind::Image)
    } else if WEB_EXTS.contains(&ext.as_str()) {
        Some(Kind::Web)
    } else {
        None
    }
}

/// The stored file name for an item: `media.<ext>` for video/images, `wallpaper.zip` for web.
pub fn stored_name(kind: Kind, ext: &str) -> String {
    match kind {
        Kind::Web => "wallpaper.zip".into(),
        _ => format!("media.{}", ext.to_ascii_lowercase()),
    }
}

/// Item ids are lowercase hex; anything else is rejected before it touches the filesystem.
pub fn valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub fn id_from_digest(digest: &[u8]) -> String {
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(id_from_digest(&h.finalize()))
}

/// A display name from a file name: "my_cool-loop.mp4" -> "my cool loop".
pub fn name_from_file(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name);
    let name: String = stem
        .chars()
        .map(|c| if c == '_' || c == '-' { ' ' } else { c })
        .collect();
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        "Untitled".into()
    } else {
        name
    }
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(kind_for_ext("MP4"), Some(Kind::Video));
        assert_eq!(kind_for_ext("gif"), Some(Kind::Image));
        assert_eq!(kind_for_ext("zip"), Some(Kind::Web));
        assert_eq!(kind_for_ext("exe"), None);
    }

    #[test]
    fn ids() {
        assert!(valid_id("0123456789abcdef"));
        assert!(!valid_id("0123456789ABCDEF"));
        assert!(!valid_id("../../etc/passwd"));
        assert_eq!(id_from_digest(&[0xab; 32]), "abababababababab");
    }

    #[test]
    fn names() {
        assert_eq!(name_from_file("my_cool-loop.mp4"), "my cool loop");
        assert_eq!(name_from_file(".mp4"), ".mp4");
    }
}

pub mod pack {
    //! Web wallpapers travel as a zip with an `index.html` at the root (or inside one top folder).

    use std::fs::File;
    use std::io::{self, Write};
    use std::path::{Path, PathBuf};
    use zip::write::SimpleFileOptions;

    fn io_err<E: std::fmt::Display>(e: E) -> io::Error {
        io::Error::other(e.to_string())
    }

    /// Wraps a single HTML file as `index.html` inside a zip.
    pub fn zip_html(html: &Path, out: &Path) -> io::Result<()> {
        let data = std::fs::read(html)?;
        let mut z = zip::ZipWriter::new(File::create(out)?);
        z.start_file("index.html", SimpleFileOptions::default()).map_err(io_err)?;
        z.write_all(&data)?;
        z.finish().map_err(io_err)?;
        Ok(())
    }

    /// Zips a folder (which must contain `index.html`).
    pub fn zip_dir(dir: &Path, out: &Path) -> io::Result<()> {
        if !dir.join("index.html").is_file() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "folder has no index.html"));
        }
        let mut z = zip::ZipWriter::new(File::create(out)?);
        let opts = SimpleFileOptions::default();
        let mut stack = vec![dir.to_path_buf()];
        let mut files: Vec<PathBuf> = Vec::new();
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d)? {
                let p = e?.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    files.push(p);
                }
            }
        }
        // Sorted so the same folder always produces the same zip (and so the same id).
        files.sort();
        for p in files {
            let rel = p.strip_prefix(dir).map_err(io_err)?;
            let name = rel.to_string_lossy().replace('\\', "/");
            z.start_file(name, opts).map_err(io_err)?;
            io::copy(&mut File::open(&p)?, &mut z)?;
        }
        z.finish().map_err(io_err)?;
        Ok(())
    }

    /// Extracts a wallpaper zip into `dest`, flattening a single top-level folder. Returns an error
    /// if there is no `index.html`.
    pub fn extract(zip_path: &Path, dest: &Path) -> io::Result<()> {
        let mut z = zip::ZipArchive::new(File::open(zip_path)?).map_err(io_err)?;
        let names: Vec<String> = z.file_names().map(String::from).collect();
        let prefix = if names.iter().any(|n| n == "index.html") {
            String::new()
        } else {
            let top = names
                .iter()
                .find(|n| n.ends_with("/index.html") && n.matches('/').count() == 1)
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "zip has no index.html"))?;
            top.trim_end_matches("index.html").to_string()
        };
        let _ = std::fs::remove_dir_all(dest);
        std::fs::create_dir_all(dest)?;
        for i in 0..z.len() {
            let mut f = z.by_index(i).map_err(io_err)?;
            let Some(rel) = f.enclosed_name() else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            let Some(rel) = rel.strip_prefix(&prefix) else { continue };
            if rel.is_empty() || f.is_dir() {
                continue;
            }
            let out = dest.join(rel);
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            io::copy(&mut f, &mut File::create(&out)?)?;
        }
        Ok(())
    }
}
