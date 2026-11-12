# Architecture

How Backdrop puts a player behind the desktop icons, renders Wallpaper Engine scenes and talks to Steam. The
[README](../README.md#how-it-works) has the overview.

## Players and the engine loop

Each display showing a moving wallpaper gets one borderless WebView window that plays it with hardware
video decoding. A spanned wallpaper gets a single window over the rectangle around all displays, so it
needs one decoder and stays in sync across them. A one-second engine loop (`engine.rs`) assigns players to
displays, applies native image wallpapers, and handles pausing. With app rules set, it also lists the
running programs every three seconds (a ToolHelp snapshot) and pauses or mutes the players while a
listed one runs.

## Scenes (`scene.rs`, `audio.rs`, `app/ui/scene/`)

`scene.rs` unpacks a `scene.pkg` into the library. The renderer runs in the player page:

- `tex.js` reads `.tex` textures (raw, LZ4, DXT, BC7, embedded PNG/JPEG, frame sheets, MP4)
- `shader.js` translates Wallpaper Engine's shaders to GLSL ES 3.00 with its own preprocessor, then repairs
  what the compiler rejects from its error messages, since they rely on HLSL's and desktop GL's loose typing
- `scene.js` holds the layers, effect chains, framebuffers, keyframes, parallax and bloom
- `puppet.js` reads `.mdl` meshes, skeletons and 3D models, `particles.js` simulates particle systems, `text.js` draws
  text and plays sound
- `script.js` runs SceneScript in a Worker with no network access or access to the app's commands
  (see [Untrusted content](#untrusted-content))

Stock shaders, effects and script classes aren't part of a wallpaper or of Backdrop. They are read from
Wallpaper Engine's install through `media://we-assets/`, so it has to stay installed. An effect that fails is
skipped and logged to `backdrop.log`; a scene that can't run at all shows its preview image. `audio.rs` turns
the system's output (WASAPI loopback) into frequency bands only while a scene that needs them is on screen,
and keeps no audio.

## Cost

Each player measures what its wallpaper costs and reports it every 20 seconds while it plays
(`player_stats`): for a scene, the main-thread time per frame and the frames drawn per second; for an
HTML page, frames and long-task time per second, which `webshim.js` counts inside the page; for video,
the share of dropped frames. `Cost::rate` in `common.rs` turns that into light, medium or heavy, and
the item keeps the latest rating in its `meta.json`.

## Wallpaper properties

Scenes and HTML wallpapers from Wallpaper Engine declare their own settings in `general.properties` of
their `project.json`. The library's sidebar shows them (`item_properties`) and saves the values the
user picks in the item's `meta.json` (`set_item_properties`), so they survive a settings reset. The
engine passes them to the player with the rest of its parameters. A scene reads them while it loads,
so a change reloads it; an HTML page gets them live through `webshim.js` as
`wallpaperPropertyListener.applyUserProperties`, all of them once and then only what changed. A
property's `condition` is evaluated by a small parser in `app.js` rather than as code, since it comes
from the download.

## Desktop attachment (`platform/windows.rs`)

The player window is reparented into Explorer's desktop window, below the icons. Before Windows 11 24H2 this
is the `WorkerW` window Explorer creates in response to message `0x052C`. On 24H2 and later, with the raised desktop, the player becomes a layered child of
`Progman` placed beneath `SHELLDLL_DefView`, the same approach used by Lively Wallpaper. If Explorer
restarts, players are recreated automatically.

## Media delivery (`media.rs`, `loopback.rs`)

Files reach the player through a custom `media://`
protocol with HTTP range support. If a WebView cannot play video through that protocol, the player falls
back to a loopback HTTP server bound to `127.0.0.1`, with a per-session secret token in the request path.

## Untrusted content

HTML wallpapers and SceneScript come from other people, so neither can reach the app's commands:

- Tauri treats a page served from one of the app's own protocols, `media://` included, as part of the
  app. An HTML wallpaper therefore runs in a sandboxed iframe on the loopback server's origin instead,
  under `/w/<item token>/<id>/web/`. The token is derived from the session secret and the item id, so
  a page reads only its own folder. The server injects `webshim.js` into the page's HTML, which
  provides Wallpaper Engine's web API and applies Backdrop's mute and pause settings.
- Commands have permissions (`build.rs`, `capabilities/`). The library window gets them all; player
  windows get only the six they use.
- A content security policy (`tauri.conf.json`) limits both windows to the app's own files, `media://`
  and the loopback server. SceneScript Workers inherit it, which keeps scripts off the network.

## Converting video (`transcode.rs`)

WebView2 can't decode HEVC or ProRes. Windows has no ProRes decoder and decodes HEVC only with a
separate Store extension, so Media Foundation isn't a dependable converter; FFmpeg is, when it's
installed (found on the `PATH`, in winget's links folders or in `C:\ffmpeg\bin`). Backdrop doesn't
ship it: a build with libx264 is GPL and about 100 MB, for a feature most libraries never need. When
it's missing, the sidebar offers Install FFmpeg, which runs `winget install --id Gyan.FFmpeg`; winget
checks the download against its manifest's hash, links `ffmpeg.exe` into its links folder (searched
directly, since the running process's `PATH` predates the install) and keeps it updated. With FFmpeg
present, the sidebar offers to convert such a video: FFmpeg writes H.264 with AAC audio to a staging file in the
library, reporting progress on `-progress pipe:1`, and the result is imported in place of the original
(`Core::replace_item`), keeping its name and its place on the displays and in rotation. Conversions
still running when Backdrop quits are stopped.

## Rotation (`rotation.rs`)

A background task checks the interval every 20 seconds. Picks come from the items marked for rotation, or
from the whole library when none are marked. With a different wallpaper on each display, a display that has
its own list (`rotation.displayPools`) picks from that instead. The engine treats a gap of more than 30
seconds between ticks as a wake from sleep.

The same task runs the schedule: for all displays, and for each display that has times of its own, the
slot whose time came most recently (yesterday's last one before the first of the day) is the one that
should be showing. It's applied when that changes and at startup, where it takes over from the random
pick, so the wallpaper can still be changed by hand in between. Times are local wall-clock minutes from
`GetLocalTime`, so daylight saving time needs no handling of its own.

## Steam Workshop (`workshop.rs`)

Browsing reads the public workshop page for item ids and gets titles, previews and tags from Steam's
`GetPublishedFileDetails` API, which needs no key. Requests go through the `curl` that ships with
Windows. Video, scene and HTML items are shown, mixed by default as on Steam; applications and presets
are left out, since Backdrop can't run them.

Anime is filtered in three steps: the query asks for the "Everyone" rating and excludes the genre tags
that turned out to be mostly anime (or memes) when sampled, items need one of the remaining genres and
no anime words (English, Chinese or Japanese) in the title or description, and anything that still slips
through can be hidden by item or by creator.

Workshop files can only be downloaded by someone who owns Wallpaper Engine, so Steam does the
downloading. *Download* works the way Wallpaper Engine does (`steamapi.rs`): a short-lived helper
(`backdrop.exe --steam-download <id>`) loads Wallpaper Engine's own `steam_api64.dll`, subscribes through
the running Steam client and reports progress until the download finishes, so no Steam window opens.
Steam shows Wallpaper Engine as running while the helper is alive. If Steam isn't running, or Wallpaper
Engine isn't installed, Backdrop opens the item in the Steam client to subscribe there instead. Once Steam
has put the item in `steamapps/workshop/content/431960/`, Backdrop imports it. A video is hard-linked
when it's on the same drive, so it takes no extra space; scenes and HTML wallpapers are copied. The *Downloaded in Steam* view lists earlier subscriptions to
add by hand.

Each workshop item remembers the newest modification time of its download. Every ten minutes the sync
loop compares it with the download, and when Steam has updated it, imports the new version in its
place: the new item keeps the name, properties, display assignments and rotation slot, and the old
one is deleted. Settings has a switch for this.

## Item identity

Each item is identified by the first 16 hex characters of its SHA-256 hash (of the file, the
`scene.pkg`, or every file of a loose scene), so adding the same file twice is caught without extra
bookkeeping. Imports run one at a time, and a failed one leaves nothing behind. Items live in the library folder as `<id>/` with a
`meta.json`, the media file and, for video and images, a `thumb.jpg` the library window renders.
