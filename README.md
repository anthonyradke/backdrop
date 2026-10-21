# Backdrop

A small live-wallpaper app for macOS and Windows, my lightweight take on Wallpaper Engine. It plays videos,
GIFs and HTML pages behind the desktop icons, and hands still images to the OS as a normal wallpaper. The
wallpaper library can live on my home server, so every computer sees the same collection.

## What it does

- Video (MP4, WebM, MOV), animated GIF and HTML/canvas/WebGL wallpapers play behind the desktop icons.
  Still images (JPG, PNG, WebP…) are set through the OS wallpaper API, so they cost nothing at all.
- A different wallpaper per display, or the same one on all of them.
- Wallpapers pause when a maximized or fullscreen app covers them, on battery, or from the tray.
- Add files by dragging them into the window or with Add files. An HTML wallpaper is a folder with an
  `index.html`, a `.zip` of one, or a single `.html` file.
- The shared library on the server: upload from any computer, download on another, or open the server's
  address in a browser to browse and upload from anything (phone included). Wallpapers always play from
  the local disk; picking one that's only on the server downloads it first.
- Closing the window keeps wallpapers running from the tray (menu bar on the Mac) and frees the window's
  memory. Start at login is a toggle in Settings.

## How it works

The app is [Tauri 2](https://tauri.app) (Rust plus the system WebView, so no bundled browser): about 5 MB
on Windows and a 2 MB installer. Each display with a moving wallpaper gets one borderless WebView window
that plays it with hardware video decoding.

- On Windows the player window is reparented into Explorer's desktop window, below the icons. Before
  Windows 11 24H2 that's the `WorkerW` window Explorer creates when sent message `0x052C`; on 24H2's
  "raised desktop" it becomes a layered child of `Progman` placed under `SHELLDLL_DefView` (the same
  approach as Lively Wallpaper). If Explorer restarts, the player is re-created.
- On macOS the player window sits at the desktop window level (above the system wallpaper, below the
  Finder icons), on every Space, ignoring the mouse, left out of Mission Control and Cmd-Tab.
- Files reach the player through a `media://` protocol with HTTP range support. If a WebView can't play
  video that way, the player switches to a tiny HTTP server on `127.0.0.1` (random port, secret token in
  the path) that serves the same files.
- Items are named by the first 16 hex characters of their SHA-256, so the same file has the same id on
  every computer and on the server, and duplicates are free.

The server is a single Rust binary that keeps files on disk (`items/<id>/meta.json`, the media file and
`thumb.jpg`). It makes thumbnails with ffmpeg; HTML wallpapers get none. It has no login, so run it where
only your own devices can reach it. Mine is behind Tailscale.

## Layout

- `crates/common`: types shared by the app and the server (items, ids, zip packing for HTML wallpapers)
- `crates/server`: the library server and its browser page (`src/index.html`)
- `app/src-tauri`: the app
  - `engine.rs` runs once a second: one player per display, native images, pausing
  - `platform/windows.rs`, `platform/macos.rs`: putting players on the desktop, native wallpapers,
    covered-screen and battery checks (`platform/other.rs` is a plain-window fallback for Linux, used only
    for development)
  - `library.rs` local library, `remote.rs` server client, `media.rs` and `loopback.rs` serve files to the
    players, `commands.rs` what the UI calls
- `app/ui`: the library window and the player page, plain HTML/CSS/JS with no build step
- `deploy/`, `install.sh`: the server's systemd unit and installer
- `scripts/`: build scripts

## Building

The Windows app cross-compiles on Linux with [cargo-xwin](https://github.com/rust-cross/cargo-xwin):

```
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin tauri-cli
sudo apt install nsis lld clang
scripts/build-windows.sh            # dist/Backdrop_<version>_x64-setup.exe
```

The Mac app has to be built on a Mac (it needs Apple's SDK). On the Mac, from the repo root:

```
scripts/build-mac.sh                # installs Rust and the Tauri CLI the first time; dist/Backdrop.app
```

On either machine, `cd app/src-tauri && cargo tauri dev` runs it from source.

The server (on the Linux box that hosts the library):

```
./install.sh             # build, install to /opt/backdrop, (re)start backdrop.service on 127.0.0.1:8092
./install.sh --publish   # also put everything in dist/ on the server's download list
```

Tests: `cargo test --workspace`.

## Known limits

- Windows WebView2 can't play HEVC/H.265 or ProRes; use H.264, VP9 or AV1 there. macOS plays all of them.
- On Windows with displays at different scaling, the player on a secondary display renders at the main
  display's scale. Video still fills the screen, possibly a touch softer.
- HTML wallpapers can't be paused from outside. The player posts `{ backdrop: { paused } }` to the page,
  and a page that listens for it can stop its own animation loop.
- Unsigned builds: Windows SmartScreen will warn the first time ("More info" > "Run anyway").
