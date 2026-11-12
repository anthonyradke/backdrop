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
