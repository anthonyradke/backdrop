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
    /// The cover as a data URL, sent only when the track changed.
    pub cover: Option<String>,
}

#[cfg(windows)]
mod session {
    use super::NowPlaying;
    use base64::Engine as _;
    use std::sync::Mutex;
    use windows::Media::Control::{GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status};
    use windows::Storage::Streams::DataReader;

    /// The track whose cover was last sent.
    static LAST: Mutex<String> = Mutex::new(String::new());

    pub fn read() -> windows::core::Result<Option<NowPlaying>> {
        let Ok(session) = Manager::RequestAsync()?.join()?.GetCurrentSession() else { return Ok(None) };
        let props = session.TryGetMediaPropertiesAsync()?.join()?;
        let mut now = NowPlaying {
            title: props.Title()?.to_string(),
            artist: props.Artist()?.to_string(),
            album: props.AlbumTitle()?.to_string(),
            playing: session.GetPlaybackInfo()?.PlaybackStatus()? == Status::Playing,
            cover: None,
        };
        let track = format!("{}\n{}", now.title, now.artist);
        let mut last = LAST.lock().unwrap();
        if *last != track {
            *last = track;
            now.cover = cover(&props).ok();
        }
        Ok(Some(now))
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

/// None when nothing is playing, or on anything but Windows.
pub fn read() -> Option<NowPlaying> {
    #[cfg(windows)]
    {
        session::read().unwrap_or_else(|e| {
            crate::log(format!("no media session: {e}"));
            None
        })
    }
    #[cfg(not(windows))]
    None
}
