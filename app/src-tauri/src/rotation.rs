//! Changing wallpapers on a timer, at startup, after waking from sleep, or from the tray's
//! "Next wallpaper". Picks come from the rotation list (or the whole library when it's empty), or,
//! with a different wallpaper on each display, from that display's own list when it has one.
//! The schedule (times of day with a chosen wallpaper) is checked by the same loop.

use crate::config::{Order, Slot};
use crate::engine::{read_displays, SPAN_KEY};
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

/// Checks every 20 seconds whether the rotation interval has passed or a scheduled time has come.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last = std::time::SystemTime::now();
        // The scheduled slots last put up, so each is applied once when its time comes (and at
        // startup), not every check; the wallpaper can be changed by hand in between.
        let mut scheduled: Option<Vec<Slot>> = None;
        loop {
            let core = app.state::<Core>();
            let schedule = core.config.lock().unwrap().schedule.clone();
            let active = active_slots(&schedule, crate::platform::local_minutes());
            if scheduled.as_ref() != Some(&active) {
                if !active.is_empty() {
                    apply_schedule(&app, &active);
                }
                scheduled = Some(active);
            }
            tokio::time::sleep(Duration::from_secs(20)).await;
            // Just back from sleep: when a wake picks a wallpaper anyway, the timer leaves it to
            // that, or the two would change it twice in a row.
            let now = std::time::SystemTime::now();
            let slept = now.duration_since(last).is_ok_and(|d| d > Duration::from_secs(60));
            last = now;
            if slept && core.config.lock().unwrap().rotation.on_wake {
                *core.rotated_at.lock().unwrap() = Instant::now();
                continue;
            }
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

/// For each place a slot can target (all displays, or one display), the slot whose time came most
/// recently, wrapping to yesterday's last one before the first time of the day. "All displays"
/// comes first so a display's own slot wins over it.
fn active_slots(schedule: &[Slot], now: u16) -> Vec<Slot> {
    let mut targets: Vec<Option<String>> = schedule.iter().map(|s| s.display.clone()).collect();
    targets.sort();
    targets.dedup();
    targets
        .into_iter()
        .filter_map(|t| {
            let mine = schedule.iter().filter(|s| s.display == t);
            let started = mine.clone().filter(|s| s.at <= now).max_by_key(|s| s.at);
            started.or_else(|| mine.max_by_key(|s| s.at)).cloned()
        })
        .collect()
}

fn apply_schedule(app: &AppHandle, slots: &[Slot]) {
    let core = app.state::<Core>();
    let known: HashSet<String> = core.library.lock().unwrap().items.keys().cloned().collect();
    let mut keys: Vec<String> = core.displays.lock().unwrap().iter().map(|d| d.display.key.clone()).collect();
    if keys.is_empty() {
        keys = read_displays(app).into_iter().map(|d| d.key).collect();
    }
    core.update_config(|c| {
        for slot in slots.iter().filter(|s| known.contains(&s.item)) {
            match (&slot.display, c.span.is_some()) {
                // A spanned wallpaper changes as one and stays spanned.
                (None, true) => c.span = Some(slot.item.clone()),
                (None, false) => {
                    for k in &keys {
                        c.assignments.insert(k.clone(), slot.item.clone());
                    }
                }
                (Some(k), false) => {
                    c.assignments.insert(k.clone(), slot.item.clone());
                }
                (Some(_), true) => {}
            }
        }
    });
    *core.rotated_at.lock().unwrap() = Instant::now();
    log(format!("schedule: {} slot(s) applied", slots.len()));
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
    let display_pools: BTreeMap<String, Vec<String>> = cfg
        .rotation
        .display_pools
        .iter()
        .map(|(k, ids)| (k.clone(), existing(&core, ids)))
        .filter(|(_, ids)| !ids.is_empty())
        .collect();
    let shuffle = matches!(why, Why::Start | Why::Wake) || cfg.rotation.order == Order::Shuffle;
    if let Some(cur) = cfg.span {
        // A spanned wallpaper changes as one and stays spanned.
        let current = BTreeMap::from([(SPAN_KEY.to_string(), cur)]);
        let picks = plan(&pool, &BTreeMap::new(), &current, &[SPAN_KEY.to_string()], false, shuffle, rand_below);
        core.update_config(|c| {
            if let Some((_, id)) = picks.into_iter().next() {
                c.span = Some(id);
            }
        });
    } else {
        let mut keys: Vec<String> = core.displays.lock().unwrap().iter().map(|d| d.display.key.clone()).collect();
        if keys.is_empty() {
            keys = read_displays(app).into_iter().map(|d| d.key).collect();
        }
        let picks = plan(&pool, &display_pools, &cfg.assignments, &keys, cfg.rotation.per_display, shuffle, rand_below);
        core.update_config(|c| {
            for (k, id) in picks {
                c.assignments.insert(k, id);
            }
        });
    }
    *core.rotated_at.lock().unwrap() = Instant::now();
    Ok(())
}

/// The ids from a list that are still in the library.
fn existing(core: &Core, ids: &[String]) -> Vec<String> {
    let lib = core.library.lock().unwrap();
    ids.iter().filter(|id| lib.items.contains_key(*id)).cloned().collect()
}

/// The ids to rotate through: the rotation list (minus anything deleted since), or every
/// wallpaper this computer can play when the list is empty.
fn candidates(core: &Core, pool: &[String]) -> Vec<String> {
    if !pool.is_empty() {
        return existing(core, pool);
    }
    let lib = core.library.lock().unwrap();
    let mut items: Vec<_> = lib
        .items
        .values()
        .filter(|i| !(cfg!(windows) && i.codec.as_deref().is_some_and(common::windows_cant_play)))
        .collect();
    items.sort_by(|a, b| a.added.cmp(&b.added).then(a.name.cmp(&b.name)));
    items.into_iter().map(|i| i.id.clone()).collect()
}

/// A random number below `n` (n > 0). Each `RandomState` gets new keys from the OS's random source,
/// so hashing anything gives a fresh number. Plenty for picking wallpapers.
fn rand_below(n: usize) -> usize {
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(common::now() as u64);
    (h.finish() % n as u64) as usize
}

/// Works out the new assignment for each display. With `per_display`, a display in `display_pools`
/// picks from its own list instead of `pool`.
fn plan(
    pool: &[String],
    display_pools: &BTreeMap<String, Vec<String>>,
    current: &BTreeMap<String, String>,
    keys: &[String],
    per_display: bool,
    shuffle: bool,
    mut rand: impl FnMut(usize) -> usize,
) -> Vec<(String, String)> {
    let mut next = |pool: &[String], cur: Option<&String>, taken: &HashSet<String>| -> Option<String> {
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
        return match next(pool, cur, &HashSet::new()) {
            Some(id) => keys.iter().map(|k| (k.clone(), id.clone())).collect(),
            None => vec![],
        };
    }
    let mut taken = HashSet::new();
    let mut out = vec![];
    for k in keys {
        let pool = display_pools.get(k).map_or(pool, Vec::as_slice);
        if let Some(id) = next(pool, current.get(k), &taken) {
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
        let p = plan(&pool, &BTreeMap::new(), &cur, &keys, false, false, |_| 0);
        assert_eq!(p, vec![("a".into(), pool[0].clone()), ("b".into(), pool[0].clone())]);
        // Nothing assigned yet starts at the top.
        let p = plan(&pool, &BTreeMap::new(), &BTreeMap::new(), &keys[..1], false, false, |_| 0);
        assert_eq!(p[0].1, pool[0]);
    }

    #[test]
    fn per_display_differs_when_it_can() {
        let pool = ids(3);
        let keys = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let p = plan(&pool, &BTreeMap::new(), &BTreeMap::new(), &keys, true, false, |_| 0);
        let got: HashSet<_> = p.iter().map(|(_, id)| id.clone()).collect();
        assert_eq!(got.len(), 3);
        // More displays than wallpapers still fills every display.
        let p = plan(&pool[..1], &BTreeMap::new(), &BTreeMap::new(), &keys, true, true, |_| 0);
        assert_eq!(p.len(), 3);
    }

    #[test]
    fn shuffle_avoids_the_current_one() {
        let pool = ids(2);
        let mut cur = BTreeMap::new();
        cur.insert("a".to_string(), pool[0].clone());
        for r in 0..5 {
            let p = plan(&pool, &BTreeMap::new(), &cur, &["a".to_string()], false, true, |n| r % n);
            assert_eq!(p[0].1, pool[1]);
        }
        assert!(plan(&[], &BTreeMap::new(), &cur, &["a".to_string()], false, true, |_| 0).is_empty());
    }

    #[test]
    fn each_display_can_have_its_own_list() {
        let pool = ids(4);
        let keys = vec!["a".to_string(), "b".to_string()];
        let own = BTreeMap::from([("b".to_string(), vec![pool[3].clone()])]);
        for r in 0..4 {
            let p = plan(&pool[..3], &own, &BTreeMap::new(), &keys, true, true, |n| r % n);
            assert!(pool[..3].contains(&p[0].1));
            assert_eq!(p[1].1, pool[3]);
        }
    }

    #[test]
    fn schedule_picks_the_latest_started_slot() {
        let slot = |at: u16, item: &str, display: Option<&str>| Slot { at, item: item.into(), display: display.map(String::from) };
        let s = vec![slot(7 * 60, "day", None), slot(19 * 60, "night", None), slot(12 * 60, "noon", Some("b"))];
        let items = |now| active_slots(&s, now).into_iter().map(|x| (x.display, x.item)).collect::<Vec<_>>();
        assert_eq!(items(8 * 60), vec![(None, "day".to_string()), (Some("b".into()), "noon".into())]);
        assert_eq!(items(20 * 60)[0].1, "night");
        // Before the first time of the day, yesterday's last one still applies.
        assert_eq!(items(3 * 60), vec![(None, "night".to_string()), (Some("b".into()), "noon".into())]);
        assert!(active_slots(&[], 600).is_empty());
    }
}
