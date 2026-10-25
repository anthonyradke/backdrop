//! Changing wallpapers on a timer, at startup, after waking from sleep, or from the tray's
//! "Next wallpaper". Picks come from the rotation list (or the whole library when it's empty).

use crate::config::Order;
use crate::engine::read_displays;
use crate::{common, log, Core};
use std::collections::{BTreeMap, HashSet};
use std::hash::{BuildHasher, Hasher};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    Timer,
    Start,
    Wake,
    Manual,
}

/// Checks every 20 seconds whether the rotation interval has passed.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(20)).await;
            let core = app.state::<Core>();
            let minutes = core.config.lock().unwrap().rotation.minutes;
            let due = minutes > 0
                && core.rotated_at.lock().unwrap().elapsed() >= Duration::from_secs(minutes as u64 * 60);
            if due {
                if let Err(e) = advance(&app, Why::Timer).await {
                    log(format!("rotation: {e}"));
                }
            }
        }
    });
}

/// Rotates in the background (for callers that can't wait).
pub fn trigger(app: &AppHandle, why: Why) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = advance(&app, why).await {
            log(format!("rotation ({why:?}): {e}"));
        }
    });
}

/// Puts the next wallpaper up. The timer and "Next" follow the chosen order; startup and wake
/// always pick at random.
pub async fn advance(app: &AppHandle, why: Why) -> Result<(), String> {
    let core = app.state::<Core>();
    *core.rotated_at.lock().unwrap() = Instant::now();
    let cfg = core.config.lock().unwrap().clone();
    let pool = candidates(&core, &cfg.rotation.pool);
    if pool.is_empty() {
        return Err("nothing to rotate through".into());
    }
    let mut keys: Vec<String> = core.displays.lock().unwrap().iter().map(|d| d.display.key.clone()).collect();
    if keys.is_empty() {
        keys = read_displays(app).into_iter().map(|d| d.key).collect();
    }
    let shuffle = matches!(why, Why::Start | Why::Wake) || cfg.rotation.order == Order::Shuffle;
    let picks = plan(&pool, &cfg.assignments, &keys, cfg.rotation.per_display, shuffle, rand_below);
    core.update_config(|c| {
        for (k, id) in picks {
            c.assignments.insert(k, id);
        }
    });
    *core.rotated_at.lock().unwrap() = Instant::now();
    Ok(())
}

/// The ids to rotate through: the rotation list (minus anything deleted since), or every
/// wallpaper this computer can play when the list is empty.
fn candidates(core: &Core, pool: &[String]) -> Vec<String> {
    let lib = core.library.lock().unwrap();
    if !pool.is_empty() {
        return pool.iter().filter(|id| lib.items.contains_key(*id)).cloned().collect();
    }
    let mut items: Vec<_> = lib
        .items
        .values()
        .filter(|i| !(cfg!(windows) && i.codec.as_deref().is_some_and(common::windows_cant_play)))
        .collect();
    items.sort_by(|a, b| a.added.cmp(&b.added).then(a.name.cmp(&b.name)));
    items.into_iter().map(|i| i.id.clone()).collect()
}

/// A random number below `n` (n > 0), from the OS-seeded hasher keys. Plenty for picking wallpapers.
fn rand_below(n: usize) -> usize {
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(Instant::now().elapsed().as_nanos() ^ common::now() as u128);
    (h.finish() % n as u64) as usize
}

/// Works out the new assignment for each display.
fn plan(
    pool: &[String],
    current: &BTreeMap<String, String>,
    keys: &[String],
    per_display: bool,
    shuffle: bool,
    mut rand: impl FnMut(usize) -> usize,
) -> Vec<(String, String)> {
    let mut next = |cur: Option<&String>, taken: &HashSet<String>| -> Option<String> {
        let free = |id: &String| !taken.contains(id) && Some(id) != cur;
        if shuffle {
            let mut choices: Vec<&String> = pool.iter().filter(|id| free(id)).collect();
            if choices.is_empty() {
                choices = pool.iter().filter(|id| Some(*id) != cur).collect();
            }
            if choices.is_empty() {
                return pool.first().cloned();
            }
            return Some(choices[rand(choices.len())].clone());
        }
        // In order: the item after the current one, wrapping, skipping ones already used.
        let start = cur.and_then(|c| pool.iter().position(|id| id == c)).map(|i| i + 1).unwrap_or(0);
        let n = pool.len();
        (0..n)
            .map(|k| &pool[(start + k) % n])
            .find(|id| free(id))
            .or_else(|| (0..n).map(|k| &pool[(start + k) % n]).find(|id| Some(*id) != cur))
            .or(pool.first())
            .cloned()
    };

    if !per_display {
        let cur = keys.iter().find_map(|k| current.get(k));
        return match next(cur, &HashSet::new()) {
            Some(id) => keys.iter().map(|k| (k.clone(), id.clone())).collect(),
            None => vec![],
        };
    }
    let mut taken = HashSet::new();
    let mut out = vec![];
    for k in keys {
        if let Some(id) = next(current.get(k), &taken) {
            taken.insert(id.clone());
            out.push((k.clone(), id));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("{i:016x}")).collect()
    }

    #[test]
    fn in_order_wraps_and_shares() {
        let pool = ids(3);
        let keys = vec!["a".to_string(), "b".to_string()];
        let mut cur = BTreeMap::new();
        cur.insert("a".to_string(), pool[2].clone());
        let p = plan(&pool, &cur, &keys, false, false, |_| 0);
        assert_eq!(p, vec![("a".into(), pool[0].clone()), ("b".into(), pool[0].clone())]);
        // Nothing assigned yet starts at the top.
        let p = plan(&pool, &BTreeMap::new(), &keys[..1], false, false, |_| 0);
        assert_eq!(p[0].1, pool[0]);
    }

    #[test]
    fn per_display_differs_when_it_can() {
        let pool = ids(3);
        let keys = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let p = plan(&pool, &BTreeMap::new(), &keys, true, false, |_| 0);
        let got: HashSet<_> = p.iter().map(|(_, id)| id.clone()).collect();
        assert_eq!(got.len(), 3);
        // More displays than wallpapers still fills every display.
        let p = plan(&pool[..1], &BTreeMap::new(), &keys, true, true, |_| 0);
        assert_eq!(p.len(), 3);
    }

    #[test]
    fn shuffle_avoids_the_current_one() {
        let pool = ids(2);
        let mut cur = BTreeMap::new();
        cur.insert("a".to_string(), pool[0].clone());
        for r in 0..5 {
            let p = plan(&pool, &cur, &["a".to_string()], false, true, |n| r % n);
            assert_eq!(p[0].1, pool[1]);
        }
        assert!(plan(&[], &cur, &["a".to_string()], false, true, |_| 0).is_empty());
    }
}
