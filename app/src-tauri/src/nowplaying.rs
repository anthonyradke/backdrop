//! What the computer is playing, from the system media session Spotify, browsers and most players
//! report to. Scenes show the title, artist and cover from it.

use serde::Serialize;

#[derive(Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    /// Which track this is, so a player can say whose cover it already has.
    pub track: String,
    /// The cover as a data URL, sent only to a player that doesn't have this track's yet.
    pub cover: Option<String>,
}

/// Cover reads for one track before giving up; right after a track change the thumbnail often
/// isn't ready yet.
#[cfg(windows)]
const COVER_TRIES: u32 = 5;

#[cfg(windows)]
mod session {
    use super::NowPlaying;
    use base64::Engine as _;
    use std::sync::Mutex;
    use windows::Media::Control::{GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status};
    use windows::Storage::Streams::DataReader;

    /// The current track, its cover once read, and how many reads have been tried.
    static LAST: Mutex<Option<(String, Option<String>, u32)>> = Mutex::new(None);

    pub fn read(have: Option<&str>) -> windows::core::Result<Option<NowPlaying>> {
        let Ok(session) = Manager::RequestAsync()?.join()?.GetCurrentSession() else { return Ok(None) };
        let props = session.TryGetMediaPropertiesAsync()?.join()?;
        let title = props.Title()?.to_string();
        let artist = props.Artist()?.to_string();
        let track = format!("{title}\n{artist}");
        let mut last = LAST.lock().unwrap();
        if last.as_ref().is_none_or(|(t, _, _)| *t != track) {
            *last = Some((track.clone(), None, 0));
        }
        let (_, cover, tries) = last.as_mut().unwrap();
        if cover.is_none() && *tries < super::COVER_TRIES {
            *tries += 1;
            *cover = self::cover(&props).ok();
        }
        Ok(Some(NowPlaying {
            title,
            artist,
            album: props.AlbumTitle()?.to_string(),
            playing: session.GetPlaybackInfo()?.PlaybackStatus()? == Status::Playing,
            cover: if have == Some(track.as_str()) { None } else { cover.clone() },
            track,
        }))
    }

    fn cover(props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> windows::core::Result<String> {
        let stream = props.Thumbnail()?.OpenReadAsync()?.join()?;
        let size = stream.Size()? as u32;
        let reader = DataReader::CreateDataReader(&stream)?;
        reader.LoadAsync(size)?.join()?;
        let mut bytes = vec![0u8; size as usize];
        reader.ReadBytes(&mut bytes)?;
        Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }
}

/// None when nothing is playing, or on anything but Windows. `have` is the track whose cover the
/// caller already has; the cover comes along only when that's not this one.
pub fn read(have: Option<&str>) -> Option<NowPlaying> {
    #[cfg(windows)]
    {
        session::read(have).unwrap_or_else(|e| {
            crate::log(format!("no media session: {e}"));
            None
        })
    }
    #[cfg(not(windows))]
    {
        let _ = have;
        None
    }
}
