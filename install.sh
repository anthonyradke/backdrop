#!/usr/bin/env bash
# Builds and (re)installs the Backdrop library server on x1.
#   ./install.sh            build, install, restart, health check
#   ./install.sh --publish  also copy built app installers from dist/ to the server's /downloads
set -euo pipefail
cd "$(dirname "$0")"
source "$HOME/.cargo/env"

cargo build --release -p backdrop-server

if ! id backdrop >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --home-dir /var/lib/backdrop --shell /usr/sbin/nologin backdrop
fi
sudo install -d -m 0755 /opt/backdrop
sudo install -m 0755 target/release/backdrop-server /opt/backdrop/backdrop-server
sudo install -m 0644 deploy/backdrop.service /etc/systemd/system/backdrop.service
sudo systemctl daemon-reload
sudo systemctl enable backdrop >/dev/null 2>&1
sudo systemctl restart backdrop

if [[ "${1:-}" == "--publish" ]]; then
  sudo install -d -o backdrop -g backdrop -m 0750 /var/lib/backdrop/releases
  shopt -s nullglob
  for f in dist/*; do
    sudo install -o backdrop -g backdrop -m 0644 "$f" /var/lib/backdrop/releases/
    echo "published $(basename "$f")"
  done
fi

for _ in 1 2 3 4 5; do
  if curl -fs http://127.0.0.1:8092/api/health >/dev/null; then
    echo "backdrop is up: $(curl -fsS http://127.0.0.1:8092/api/items | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))') items"
    exit 0
  fi
  sleep 1
done
echo "backdrop did not answer; see: journalctl -u backdrop -n 50" >&2
exit 1
