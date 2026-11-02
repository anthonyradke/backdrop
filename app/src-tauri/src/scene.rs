//! Wallpaper Engine scene wallpapers: a `scene.pkg` archive (or the same files loose) that describes
//! layers, effects and particles. They're unpacked into `<id>/scene/` and the player's WebGL
//! renderer (`app/ui/scene/`) does the rest. Stock shaders and effects aren't part of a wallpaper;
//! the renderer reads them from Wallpaper Engine's own install through `we-assets/` on `media://`.

use crate::common::{self, Item, Kind};
use serde::Deserialize;
use std::collections::HashMap;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Where the unpacked wallpaper lives inside its library folder.
pub const DIR: &str = "scene";
const PKG: &str = "scene.pkg";
/// More files than any real wallpaper; a bad archive shouldn't allocate without limit.
const MAX_FILES: u32 = 200_000;

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn u32(&mut self) -> io::Result<u32> {
        let b = self.data.get(self.at..self.at + 4).ok_or_else(|| invalid("pkg: truncated"))?;
        self.at += 4;
        Ok(u32::from_le_bytes(b.try_into().unwrap()))
    }

    fn string(&mut self) -> io::Result<String> {
        let n = self.u32()? as usize;
        let b = self.data.get(self.at..self.at + n).ok_or_else(|| invalid("pkg: truncated"))?;
        self.at += n;
        Ok(String::from_utf8_lossy(b).into_owned())
    }
}

/// A file name from an archive, as a path that stays inside the folder it's unpacked to.
fn safe_path(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains(':') || name.contains('\0') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in name.split(['/', '\\']) {
        let mut c = Path::new(part).components();
        match (c.next(), c.next()) {
            (Some(Component::Normal(p)), None) => out.push(p),
            _ => return None,
        }
    }
    Some(out)
}

/// Unpacks a `scene.pkg`: a `PKGV....` version string, a file table, then the files.
pub fn unpack(pkg: &Path, dest: &Path) -> io::Result<()> {
    let data = std::fs::read(pkg)?;
    let mut r = Reader { data: &data, at: 0 };
    if !r.string()?.starts_with("PKGV") {
        return Err(invalid("not a scene package"));
    }
    let count = r.u32()?;
    if count > MAX_FILES {
        return Err(invalid("pkg: too many files"));
    }
    let mut files = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let (name, offset, len) = (r.string()?, r.u32()? as usize, r.u32()? as usize);
        files.push((name, offset, len));
    }
    let base = r.at;
    for (name, offset, len) in files {
        let path = safe_path(&name).ok_or_else(|| invalid(format!("pkg: bad file name {name}")))?;
        let start = base.checked_add(offset).ok_or_else(|| invalid("pkg: bad offset"))?;
        let bytes = start
            .checked_add(len)
            .and_then(|end| data.get(start..end))
            .ok_or_else(|| invalid(format!("pkg: {name} runs past the end")))?;
        let out = dest.join(path);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(out, bytes)?;
    }
    Ok(())
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Project {
    title: String,
    #[serde(rename = "type")]
    kind: String,
    preview: String,
}

fn project(dir: &Path) -> Option<Project> {
    let bytes = std::fs::read(dir.join("project.json")).ok()?;
    // Windows editors leave a byte order mark, which serde refuses.
    let text = String::from_utf8_lossy(&bytes);
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

/// Whether a folder is a scene wallpaper.
pub fn is_scene(dir: &Path) -> bool {
    dir.is_dir() && project(dir).is_some_and(|p| p.kind.eq_ignore_ascii_case("scene"))
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<u64> {
    std::fs::create_dir_all(to)?;
    let mut size = 0;
    for e in std::fs::read_dir(from)?.flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_name() == PKG {
            continue;
        }
        if src.is_dir() {
            size += copy_tree(&src, &dst)?;
        } else {
            size += std::fs::copy(&src, &dst)?;
        }
    }
    Ok(size)
}

fn folder_size(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    rd.flatten().map(|e| if e.path().is_dir() { folder_size(&e.path()) } else { e.metadata().map_or(0, |m| m.len()) }).sum()
}

/// Copies a scene wallpaper into the library, unpacking its package over the loose files.
/// Blocking; the caller adds the result to the map.
pub fn import(root: &Path, src: &Path, existing: &HashMap<String, Item>) -> io::Result<Item> {
    let meta = project(src).ok_or_else(|| invalid("no project.json"))?;
    let pkg = src.join(PKG);
    let id = common::hash_file(&if pkg.is_file() { pkg.clone() } else { src.join("project.json") })?;
    if let Some(item) = existing.get(&id) {
        return Ok(item.clone());
    }
    let dir = root.join(&id);
    let _ = std::fs::remove_dir_all(&dir);
    let out = dir.join(DIR);
    let result = (|| {
        copy_tree(src, &out)?;
        if pkg.is_file() {
            unpack(&pkg, &out)?;
        }
        if !out.join("project.json").is_file() {
            return Err(invalid("no project.json"));
        }
        let preview = safe_path(&meta.preview).filter(|p| out.join(p).is_file()).map(|p| format!("{DIR}/{}", p.to_string_lossy().replace('\\', "/")));
        let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("Scene").to_string();
        let item = Item {
            id: id.clone(),
            name: if meta.title.trim().is_empty() { name } else { meta.title.trim().to_string() },
            kind: Kind::Scene,
            file: format!("{DIR}/project.json"),
            size: folder_size(&out),
            width: None,
            height: None,
            codec: None,
            fps: None,
            added: common::now(),
            tags: vec![],
            workshop: None,
            preview,
        };
        crate::library::write_meta(&dir, &item)?;
        Ok(item)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    result
}

/// Wallpaper Engine's stock shaders, effects and materials.
pub fn stock_dir() -> Option<PathBuf> {
    crate::workshop::steam_libraries()
        .into_iter()
        .map(|lib| lib.join("steamapps").join("common").join("wallpaper_engine").join("assets"))
        .find(|p| p.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkg(files: &[(&str, &[u8])], version: &str) -> Vec<u8> {
        fn string(out: &mut Vec<u8>, s: &str) {
            out.extend((s.len() as u32).to_le_bytes());
            out.extend(s.as_bytes());
        }
        let mut out = vec![];
        string(&mut out, version);
        out.extend((files.len() as u32).to_le_bytes());
        let mut offset = 0u32;
        for (name, data) in files {
            string(&mut out, name);
            out.extend(offset.to_le_bytes());
            out.extend((data.len() as u32).to_le_bytes());
            offset += data.len() as u32;
        }
        for (_, data) in files {
            out.extend(*data);
        }
        out
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("backdrop-scene-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn unpacks_every_package_version() {
        let tmp = temp("unpack");
        for v in ["PKGV0001", "PKGV0024"] {
            let p = tmp.join("scene.pkg");
            std::fs::write(&p, pkg(&[("scene.json", b"{}"), ("materials/a b.tex", b"abc")], v)).unwrap();
            let out = tmp.join(v);
            unpack(&p, &out).unwrap();
            assert_eq!(std::fs::read(out.join("materials/a b.tex")).unwrap(), b"abc");
            assert_eq!(std::fs::read(out.join("scene.json")).unwrap(), b"{}");
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn refuses_files_outside_the_folder() {
        let tmp = temp("escape");
        let p = tmp.join("scene.pkg");
        for name in ["../evil.txt", "/etc/evil", "a/../../evil", "C:\\evil", "..\\evil", ""] {
            std::fs::write(&p, pkg(&[(name, b"x")], "PKGV0001")).unwrap();
            assert!(unpack(&p, &tmp.join("out")).is_err(), "{name}");
        }
        assert!(!tmp.join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn survives_damaged_packages() {
        let tmp = temp("damaged");
        let p = tmp.join("scene.pkg");
        let good = pkg(&[("a.txt", b"hello")], "PKGV0001");
        for cut in 0..good.len() {
            std::fs::write(&p, &good[..cut]).unwrap();
            assert!(unpack(&p, &tmp.join("out")).is_err(), "cut at {cut}");
        }
        std::fs::write(&p, b"not a package at all").unwrap();
        assert!(unpack(&p, &tmp.join("out")).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn imports_a_workshop_folder() {
        let tmp = temp("import");
        let src = tmp.join("1234");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("project.json"), "\u{feff}{\"title\":\" Rain \",\"type\":\"Scene\",\"file\":\"scene.json\",\"preview\":\"preview.gif\"}").unwrap();
        std::fs::write(src.join("preview.gif"), b"GIF").unwrap();
        std::fs::write(src.join(PKG), pkg(&[("scene.json", b"{}")], "PKGV0023")).unwrap();
        assert!(is_scene(&src));

        let root = tmp.join("lib");
        std::fs::create_dir_all(&root).unwrap();
        let item = import(&root, &src, &HashMap::new()).unwrap();
        assert_eq!((item.kind, item.name.as_str()), (Kind::Scene, "Rain"));
        assert_eq!(item.preview.as_deref(), Some("scene/preview.gif"));
        assert!(root.join(&item.id).join("scene/scene.json").is_file());
        assert!(!root.join(&item.id).join("scene").join(PKG).exists());
        assert_eq!(crate::library::Library::player_src(&item), format!("{}/scene/", item.id));
        let lib = crate::library::Library::open(root.clone());
        assert!(lib.items.contains_key(&item.id));
        // Importing it again finds the same item.
        let again = crate::library::import(&root, &src, &lib.items).unwrap();
        assert_eq!(again.id, item.id);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
