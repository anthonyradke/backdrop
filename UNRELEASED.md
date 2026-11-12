# Unreleased

Changes since the last release. Each fix or feature adds a line here; `scripts/release.sh` turns
this list into the release notes and empties it for the next batch.

- The library keeps each wallpaper's controls and details in a sidebar next to the grid instead of a
  banner above it
- Select mode in the library: tick several wallpapers (shift-click for a range, Ctrl+A for all shown) to
  delete them or add them to rotation together
- Workshop > Discover shows scenes, videos and HTML wallpapers together by default, so scene wallpapers
  turn up without picking the Scene filter
- New look modeled on T3 Code: a nav on the left with what each display is showing, a slim header with each
  page's actions, neutral surfaces with hairline borders, and settings grouped in cards
- HTML wallpapers run in a sandboxed frame on a local web origin, so a downloaded page can no longer
  use Backdrop's commands; pausing and muting now also apply to their audio and video
- Scene scripts can no longer reach the network
- Scenes play at their real speed; before, they ran at half speed or slower depending on the
  display's refresh rate
- Changing wallpapers no longer leaves the previous one playing (with sound) behind the new one when
  the new one fails to load or the change is quick
- A scene's still frame is always taken from that scene, and a video paused while loading stays paused
- Workshop items and zip files can no longer point Backdrop at files outside their own folder
- A scene whose script never finishes, or whose particles nest or burst without limit, no longer
  freezes the wallpaper or pins a CPU core
- Scenes with uncompressed high-precision textures show them instead of white
- Adding the same wallpaper twice at once (a drop while the Workshop sync imports it) no longer
  breaks it, and a failed import leaves no half-copied folder behind
- Music scenes on every display get the album cover, also when they start mid-song
- A settings file Backdrop can't fully read (after going back to an older version, say) keeps every
  setting it can instead of resetting all of them, and the original is saved as `config.json.bad`
- Select mode only acts on wallpapers the grid is showing, and leaving it clears the ticks
- A Workshop page that fails to load more says so and can be retried; typed Workshop searches survive
  until Enter
- Switches, sliders and search fields have accessible names, and the Workshop dialog and the tour keep
  keyboard focus inside them
- Scene shaders with a `/*` inside a line comment, hex numbers or integer division in `#if` compile
  as written
- A scene comes back on its own after a GPU reset or driver update instead of staying black
- Scenes free the fonts and GPU memory they use when they're replaced, and scripts that keep making
  and removing layers no longer leak memory
- A Workshop download that stalls, or a helper that doesn't answer, no longer keeps Steam showing
  Wallpaper Engine as running; pressing Download twice doesn't start a second download
- Unplugging a dock no longer counts as waking from sleep, waking no longer changes the wallpaper twice,
  and a still image Windows refused at login is applied once it can be
- "Fit height" applies one position to every display, as Windows requires, instead of whichever
  display was set last
- Music bars in scenes fall back down when the music stops
- Paused scenes use no CPU at all, and large scenes use less memory
- Backdrop stops waiting for a subscribed Workshop item after a day if Steam never delivers it
- Scenes and HTML wallpapers that have their own settings (colours, sliders, switches, lists) show them
  in the library's sidebar, and changes apply right away
- HTML wallpapers made for Wallpaper Engine get its web API: their properties, audio levels for
  visualizers, and the track that's playing
- Workshop wallpapers stay up to date: when Steam downloads a new version, it replaces the one in the
  library, keeping its name, settings and place (switch in Settings)
- A schedule in Settings changes the wallpaper at set times of day, on all displays or on one
- With a different wallpaper on each display, each display can have its own rotation list
- Settings can name programs that pause or mute the wallpapers while they run
- The library shows what each wallpaper costs to show (light, medium or heavy), measured while it plays
- HEVC and ProRes videos, which Windows can't play here, can be converted to H.264 from the library
  with FFmpeg, which the library can install through winget
