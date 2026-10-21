#!/usr/bin/env bash
# Builds Backdrop.app and a .dmg on the Mac. Run from the repo root on the Mac.
# First run installs Rust (user-local, no sudo) and the Tauri CLI; needs the Xcode command line tools.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v cargo >/dev/null 2>&1 && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
source "$HOME/.cargo/env"
xcode-select -p >/dev/null 2>&1 || { echo "Install the Xcode command line tools first: xcode-select --install"; exit 1; }
cargo tauri --version >/dev/null 2>&1 || cargo install --locked tauri-cli
(cd app/src-tauri && cargo tauri build)
mkdir -p dist
cp -R target/release/bundle/macos/Backdrop.app dist/ 2>/dev/null || true
cp target/release/bundle/dmg/*.dmg dist/ 2>/dev/null || true
ls -la dist
echo
echo "Install: drag dist/Backdrop.app to /Applications (or open the .dmg)."
