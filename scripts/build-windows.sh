#!/usr/bin/env bash
# Cross-compiles the Windows app and installer on x1 (Linux) with cargo-xwin, then copies the
# installer to dist/. Needs: rustup target x86_64-pc-windows-msvc, cargo-xwin, tauri-cli, nsis, lld.
set -euo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.cargo/env"
export XWIN_ACCEPT_LICENSE=1
(cd app/src-tauri && cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc)
mkdir -p dist
cp target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe dist/
ls -la dist
