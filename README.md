<p align="center">
  <img src="docs/icon.png" width="128" height="128" alt="Backdrop icon">
</p>

<h1 align="center">Backdrop</h1>

<p align="center">Live wallpapers for Windows, with an optional self-hosted library server.</p>

---

Backdrop plays videos, animated GIFs and HTML pages behind the desktop icons. Still images are passed to
the operating system as a regular wallpaper, so they use no resources once set. Wallpapers can be kept in
a shared library on your own server, so every computer you use sees the same collection.

The app is built on [Tauri 2](https://tauri.app) and uses the system WebView instead of a bundled browser.
The Windows build is about 5 MB installed, from a 2 MB installer.

## Features

- Video (MP4, WebM, MOV), animated GIF and HTML/canvas/WebGL wallpapers rendered behind the desktop icons
- Still images (JPG, PNG, WebP and others) set through the native wallpaper API
- A separate wallpaper per display, or one across all displays
- Fill, fit, fit-height, stretch and center scaling; playback speed from 0.5× to 2×; optional audio
- A full-resolution frame of each moving wallpaper is set as the Windows wallpaper, so the desktop matches
  it before Backdrop starts
- Rotation on a timer (in order or shuffled, the same or different on each display), plus a random pick at
  startup or after waking from sleep, and a *Next wallpaper* item in the tray menu
- Automatic pause when a window covers the wallpaper, when another app is in front, on battery, with
  battery saver on, and while the screen is locked
- Resolution badges (4K, 1440p, 1080p) and codec details for each item, with a warning on HEVC and ProRes
  files, which Windows can't play
- Drag-and-drop import; HTML wallpapers can be a folder with an `index.html`, a `.zip` of one, or a single
  `.html` file
- Optional library server: upload from one computer, download on another, or manage the library from any
  browser, including a phone
- Server-side conversion to H.264, optionally at a lower resolution or frame rate, for a copy that plays
  everywhere and uses less power
- Free-up-space and reset options; interface in English, Spanish, German and Simplified Chinese
- Runs from the system tray with the main window closed, and can start at login

## Requirements

| Component | Requirement |
|---|---|
| Windows app | Windows 10 or 11 with WebView2 (preinstalled on Windows 11) |
| Library server | Linux with `ffmpeg` and `ffprobe` (with libx264 and zscale) on the `PATH` |

## Installation

Builds are not yet code-signed.

Run `Backdrop_<version>_x64-setup.exe`. SmartScreen warns on first launch; choose
*More info* > *Run anyway*. The installer is per-user and needs no administrator rights.

To connect a library server, enter its address in Settings.

## Architecture

```
crates/
  common/      types shared by the app and the server: items, ids, zip packing for HTML wallpapers
  server/      library server and its browser interface (src/index.html)
app/
  src-tauri/   desktop app (Rust)
  ui/          library window and player page; plain HTML, CSS and JavaScript with no build step;
               translations in i18n.js
deploy/        systemd unit for the server
scripts/       Windows build script
```

### Desktop app

Each display showing a moving wallpaper gets one borderless WebView window that plays it with hardware
video decoding. A one-second engine loop (`engine.rs`) assigns players to displays, applies native image
wallpapers, and handles pausing.

#### Desktop attachment (`platform/windows.rs`)

The player window is reparented into Explorer's desktop window, below the icons. Before Windows 11 24H2 this is the `WorkerW` window Explorer creates in response to
message `0x052C`. On 24H2 and later, with the raised desktop, the player becomes a layered child of
`Progman` placed beneath `SHELLDLL_DefView`, the same approach used by Lively Wallpaper. If Explorer
restarts, players are recreated automatically.

#### Media delivery (`media.rs`, `loopback.rs`)

Files reach the player through a custom `media://`
protocol with HTTP range support. If a WebView cannot play video through that protocol, the player falls
back to a loopback HTTP server bound to `127.0.0.1` on a random port, with a per-session secret token in
the request path.

#### Rotation (`rotation.rs`)

A background task checks the interval every 20 seconds. Picks come from the items marked for rotation, or
from the whole local library when none are marked; items that exist only on the server are downloaded when
their turn comes. The engine treats a gap of more than 30 seconds between ticks as a wake from sleep.

#### Item identity

Each item is identified by the first 16 hex characters of its SHA-256 hash. The same
file has the same id on every computer and on the server, so duplicates are detected without extra
bookkeeping. Wallpapers always play from local disk; selecting one that exists only on the server
downloads it first.

### Library server

The server is a single Rust binary with no database. Each item is stored as `items/<id>/` containing
`meta.json`, the media file, and a `thumb.jpg` generated with ffmpeg (HTML wallpapers have no thumbnail).
The item list is rebuilt from the metadata files at startup, and ffprobe records each video's codec,
resolution and frame rate.

Conversions run one at a time with libx264. The short side is scaled down to `maxHeight` and the frame rate
lowered to `maxFps` only when the source exceeds them, and HDR footage is tone-mapped to SDR. The result is
stored as a new item next to the original.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Browser interface |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/items` | List items |
| `POST` | `/api/upload` | Upload an item |
| `GET` `PATCH` `DELETE` | `/api/items/{id}` | Read, rename or delete an item |
| `GET` | `/api/items/{id}/file` | Download the media file |
| `GET` `PUT` | `/api/items/{id}/thumb` | Read or replace the thumbnail |
| `POST` | `/api/items/{id}/convert` | Start an H.264 copy; body `{ "maxHeight": 1080, "maxFps": 30 }`, both optional |
| `GET` | `/api/jobs` | Conversion progress |
| `GET` | `/downloads`, `/downloads/{name}` | App installers published by the server |

Configuration is through environment variables:

| Variable | Default | Description |
|---|---|---|
| `BACKDROP_ADDR` | `127.0.0.1:8092` | Listen address |
| `BACKDROP_DATA` | `./backdrop-library` | Data directory |
| `RUST_LOG` | `info` | Log level |

> [!WARNING]
> The server has no authentication. Run it only on a network limited to your own devices, such as a
> Tailscale tailnet or a LAN behind a firewall. Do not expose it to the internet.

## Building from source

Requires a recent stable Rust toolchain.

### Windows app (cross-compiled from Linux)

The Windows app is built on Linux with [cargo-xwin](https://github.com/rust-cross/cargo-xwin):

```sh
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin tauri-cli
sudo apt install nsis lld clang
scripts/build-windows.sh        # output: dist/Backdrop_<version>_x64-setup.exe
```

### Development

```sh
cd app/src-tauri && cargo tauri dev
```

On Linux the app runs in a plain window (`platform/other.rs`) for development only.

### Server

On the Linux host:

```sh
./install.sh              # build, install to /opt/backdrop, and (re)start backdrop.service
./install.sh --publish    # also publish everything in dist/ to the server's download list
```

### Tests

```sh
cargo test --workspace
```

## Known limitations

- WebView2 cannot decode HEVC/H.265 or ProRes. Use H.264, VP9 or AV1, or convert the
  file on the server.
- The still frame covers the desktop wallpaper only. The lock screen keeps its own image.
- With mixed display scaling, the player on a secondary display renders at the primary display's
  scale. Video still fills the screen but may appear slightly softer.
- HTML wallpapers cannot be paused externally. The player posts `{ backdrop: { paused, muted, volume, speed } }`
  to the page; pages that listen for this message can stop their own animation loop.
- Codec detection for files added locally reads MP4 and MOV headers only; other formats get their codec once
  they are on the server.

## License

[MIT](LICENSE)
