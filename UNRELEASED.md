# Unreleased

Changes since the last release. Each fix or feature adds a line here; `scripts/release.sh` turns
this list into the release notes and empties it for the next batch.

- When winget is missing or can't install FFmpeg, the library says why and offers Download FFmpeg
  and Try again instead of a toast that disappears; an FFmpeg winget unpacked but couldn't link is
  found too
