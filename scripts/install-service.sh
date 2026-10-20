#!/usr/bin/env bash
# Installs Hearthbeat as a systemd service (Raspberry Pi / any Linux with systemd).
# Run from the repo folder:  bash scripts/install-service.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
NODE_BIN="$(command -v node || true)"
SERVICE=/etc/systemd/system/hearthbeat.service

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js not found. Install it first (see README)." >&2
  exit 1
fi

NODE_VER="$("$NODE_BIN" -p 'process.versions.node')"
if ! "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>18||(a===18&&b>=17)?0:1)'; then
  echo "Node $NODE_VER is too old; Hearthbeat needs 18.17 or newer (see README)." >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "No .env in $APP_DIR. Run: cp .env.example .env  and fill it in first." >&2
  exit 1
fi

if [[ ! -d "$APP_DIR/node_modules" ]]; then
  echo "Installing dependencies..."
  (cd "$APP_DIR" && npm ci --omit=dev)
fi

echo "Writing $SERVICE (user: $RUN_USER, dir: $APP_DIR, node: $NODE_BIN v$NODE_VER)"
sudo tee "$SERVICE" > /dev/null <<EOF
[Unit]
Description=Hearthbeat (WoW realm status Discord bot)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now hearthbeat
sleep 3
sudo systemctl --no-pager --lines=10 status hearthbeat || true

echo
echo "Done. Useful commands:"
echo "  journalctl -u hearthbeat -f        # live logs"
echo "  sudo systemctl restart hearthbeat  # after editing .env or pulling updates"
echo "  sudo systemctl stop hearthbeat     # stop it"
