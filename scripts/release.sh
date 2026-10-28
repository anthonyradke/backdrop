#!/bin/sh
# Release Backdrop: scripts/release.sh 0.2.0
# Takes the list in UNRELEASED.md as the release notes (the tag message, which CI publishes with the
# installer and the in-app update shows), bumps the version, empties the list, commits, tags and
# pushes. CI then builds, signs and publishes the release.
set -e
cd "$(dirname "$0")/.."
v=${1:?usage: scripts/release.sh X.Y.Z}
notes=$(sed -n '/^- /,$p' UNRELEASED.md)
[ -n "$notes" ] || { echo "UNRELEASED.md has no changes listed"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first"; exit 1; }
git rev-parse -q --verify "refs/tags/v$v" >/dev/null && { echo "v$v already exists"; exit 1; }

sed -i "0,/^version = \".*\"/s//version = \"$v\"/" Cargo.toml
sed -i "0,/\"version\": \".*\"/s//\"version\": \"$v\"/" app/src-tauri/tauri.conf.json
cargo update -p backdrop --offline -q
sed -i '/^- /,$d' UNRELEASED.md

git add UNRELEASED.md Cargo.lock Cargo.toml app/src-tauri/tauri.conf.json
git commit -qm "release $v"
printf '%s\n' "$notes" | git tag -a "v$v" -F -
git push -q
git push -q origin "v$v"
echo "pushed v$v; CI is building the release:"
printf '%s\n' "$notes"
