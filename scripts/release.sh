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
git ls-remote --exit-code --tags origin "refs/tags/v$v" >/dev/null && { echo "v$v already exists on origin"; exit 1; }
# CI tests on Windows and only publishes when that passes, so catch what would stop it here, before
# a tag exists: a commit that already failed on GitHub, or code that doesn't compile for Windows.
if [ "$(gh run list --workflow check.yml --commit "$(git rev-parse HEAD)" --json conclusion -q '.[0].conclusion' 2>/dev/null)" = failure ]; then
    echo "the check workflow failed on this commit; fix it first"; exit 1
fi
XWIN_ACCEPT_LICENSE=1 cargo xwin check -q --target x86_64-pc-windows-msvc --workspace --all-targets || { echo "Backdrop doesn't build for Windows; nothing was changed"; exit 1; }

sed -i "0,/^version = \".*\"/s//version = \"$v\"/" Cargo.toml
sed -i "0,/\"version\": \".*\"/s//\"version\": \"$v\"/" app/src-tauri/tauri.conf.json
cargo update -p backdrop --offline -q
sed -i '/^- /,$d' UNRELEASED.md

git add UNRELEASED.md Cargo.lock Cargo.toml app/src-tauri/tauri.conf.json
git commit -qm "release $v"
printf '%s\n' "$notes" | git tag -a "v$v" -F -
# Both or neither: a release commit without its tag (or the reverse) can't happen.
git push -q --atomic origin main "v$v"
echo "pushed v$v; CI is building the release:"
printf '%s\n' "$notes"
