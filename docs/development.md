# Development

Requires a recent stable Rust toolchain.

## Windows app (cross-compiled from Linux)

The Windows app is built on Linux with [cargo-xwin](https://github.com/rust-cross/cargo-xwin):

```sh
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin tauri-cli
sudo apt install nsis lld clang
scripts/build-windows.sh        # output: dist/Backdrop_<version>_x64-setup.exe
```

The installer is signed for the updater, so a release build needs the signing key in
`TAURI_SIGNING_PRIVATE_KEY` and its password in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## Releases

Releases are built by GitHub Actions (`.github/workflows/release.yml`). `scripts/release.sh X.Y.Z` takes
the list in `UNRELEASED.md` as the release notes, bumps the version, tags and pushes; CI builds, signs and
publishes the installer with the `latest.json` the in-app updater reads, and the update button shows the
notes.

## Running locally

```sh
cd app/src-tauri && cargo tauri dev
```

On Linux the app runs in a plain window (`platform/other.rs`) for development only.

## Tests

```sh
cargo test --workspace
```
