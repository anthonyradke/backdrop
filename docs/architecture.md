# Architecture

How Backdrop puts a player behind the desktop icons, renders Wallpaper Engine scenes and talks to Steam. The
[README](../README.md#how-it-works) has the overview.

## Players and the engine loop

Each display showing a moving wallpaper gets one borderless WebView window that plays it with hardware
video decoding. A spanned wallpaper gets a single window over the rectangle around all displays, so it
needs one decoder and stays in sync across them. A one-second engine loop (`engine.rs`) assigns players to
displays, applies native image wallpapers, and handles pausing.

## Scenes (`scene.rs`, `audio.rs`, `app/ui/scene/`)

`scene.rs` unpacks a `scene.pkg` into the library. The renderer runs in the player page:

- `tex.js` reads `.tex` textures (raw, LZ4, DXT, BC7, embedded PNG/JPEG, frame sheets, MP4)
- `shader.js` translates Wallpaper Engine's shaders to GLSL ES 3.00 with its own preprocessor, then repairs
  what the compiler rejects from its error messages, since they rely on HLSL's and desktop GL's loose typing
- `scene.js` holds the layers, effect chains, framebuffers, keyframes, parallax and bloom
- `puppet.js` reads `.mdl` meshes, skeletons and 3D models, `particles.js` simulates particle systems, `text.js` draws
  text and plays sound
- `script.js` runs SceneScript in a Worker with no network access or access to the app's commands

Stock shaders, effects and script classes aren't part of a wallpaper or of Backdrop. They are read from
Wallpaper Engine's install through `media://we-assets/`, so it has to stay installed. An effect that fails is
skipped and logged to `backdrop.log`; a scene that can't run at all shows its preview image. `audio.rs` turns
the system's output (WASAPI loopback) into frequency bands only while a scene that needs them is on screen,
and keeps no audio.

## Desktop attachment (`platform/windows.rs`)

The player window is reparented into Explorer's desktop window, below the icons. Before Windows 11 24H2 this
is the `WorkerW` window Explorer creates in response to message `0x052C`. On 24H2 and later, with the raised desktop, the player becomes a layered child of
`Progman` placed beneath `SHELLDLL_DefView`, the same approach used by Lively Wallpaper. If Explorer
restarts, players are recreated automatically.

## Media delivery (`media.rs`, `loopback.rs`)

Files reach the player through a custom `media://`
protocol with HTTP range support. If a WebView cannot play video through that protocol, the player falls
back to a loopback HTTP server bound to `127.0.0.1` on a random port, with a per-session secret token in
the request path.

## Rotation (`rotation.rs`)

A background task checks the interval every 20 seconds. Picks come from the items marked for rotation, or
from the whole library when none are marked. The engine treats a gap of more than 30 seconds between ticks as
a wake from sleep.

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
has put the item in `steamapps/workshop/content/431960/`, Backdrop imports it, hard-linked when it's on
the same drive so it takes no extra space. The *Downloaded in Steam* view lists earlier subscriptions to
add by hand.

## Item identity

Each item is identified by the first 16 hex characters of its SHA-256 hash, so adding the same file
twice is caught without extra bookkeeping. Items live in the library folder as `<id>/` with a
`meta.json`, the media file and, for video and images, a `thumb.jpg` the library window renders.
