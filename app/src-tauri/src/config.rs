use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    #[default]
    Cover,
    Contain,
    Stretch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// Base URL of the shared library on x1, e.g. `https://host:8448`. Empty = local only.
    pub server: String,
    /// Display key -> item id.
    pub assignments: BTreeMap<String, String>,
    pub fit: Fit,
    pub muted: bool,
    /// 0.0 - 1.0
    pub volume: f64,
    pub pause_covered: bool,
    pub pause_battery: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: String::new(),
            assignments: BTreeMap::new(),
            fit: Fit::Cover,
            muted: true,
            volume: 0.5,
            pause_covered: true,
            pause_battery: true,
        }
    }
}

pub fn load(path: &Path) -> Config {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, cfg: &Config) {
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(cfg).expect("config serializes");
    if std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, path)).is_err() {
        crate::log(format!("could not save {}", path.display()));
    }
}

/// `x1.example.ts.net:8448` -> `https://x1.example.ts.net:8448`; trailing slashes removed.
pub fn normalize_server(s: &str) -> String {
    let s = s.trim().trim_end_matches('/');
    if s.is_empty() {
        String::new()
    } else if s.starts_with("http://") || s.starts_with("https://") {
        s.to_string()
    } else {
        format!("https://{s}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_urls() {
        assert_eq!(normalize_server(" host:8448/ "), "https://host:8448");
        assert_eq!(normalize_server("http://127.0.0.1:8092"), "http://127.0.0.1:8092");
        assert_eq!(normalize_server(""), "");
    }

    #[test]
    fn partial_config_fills_defaults() {
        let c: Config = serde_json::from_str(r#"{"server":"https://a"}"#).unwrap();
        assert!(c.muted && c.pause_covered);
        assert_eq!(c.server, "https://a");
    }
}
