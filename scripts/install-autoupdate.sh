#!/usr/bin/env bash
# Installs a systemd timer that checks GitHub every minute and, when main has new commits,
# updates this checkout and restarts hearthbeat. Run after install-service.sh.
# Run from the repo folder:  bash scripts/install-autoupdate.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
NODE_BIN="$(command -v node || true)"
UPDATER=/usr/local/bin/hearthbeat-update
SERVICE=/etc/systemd/system/hearthbeat-update.service
TIMER=/etc/systemd/system/hearthbeat-update.timer

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js not found. Install it first (see README)." >&2
  exit 1
fi

if [[ ! -f /etc/systemd/system/hearthbeat.service ]]; then
  echo "hearthbeat service not found. Run: bash scripts/install-service.sh  first." >&2
  exit 1
fi

# The updater lives outside the repo so an update can't rewrite the script while it runs
echo "Writing $UPDATER (user: $RUN_USER, dir: $APP_DIR)"
sudo tee "$UPDATER" > /dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$APP_DIR"
as_user() { runuser -u "$RUN_USER" -- env "PATH=$(dirname "$NODE_BIN"):\$PATH" "\$@"; }

as_user git fetch --quiet origin main
target="\$(as_user git rev-parse origin/main)"
# Compare against the last commit that finished deploying, so a failed install is retried
deployed="\$(cat .git/hearthbeat-deployed 2>/dev/null || true)"
[[ "\$target" == "\$deployed" ]] && exit 0

# Mirror GitHub exactly: local edits to tracked files are discarded, .env is untouched
as_user git reset --hard --quiet "\$target"
as_user npm ci --omit=dev
systemctl restart hearthbeat
echo "\$target" > .git/hearthbeat-deployed
echo "Updated hearthbeat to \${target:0:7}"
EOF
sudo chmod +x "$UPDATER"

sudo tee "$SERVICE" > /dev/null <<EOF
[Unit]
Description=Update hearthbeat from GitHub
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=$UPDATER
EOF

sudo tee "$TIMER" > /dev/null <<EOF
[Unit]
Description=Check GitHub for hearthbeat updates every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now hearthbeat-update.timer
sudo systemctl start hearthbeat-update.service || true
sudo systemctl --no-pager --lines=10 status hearthbeat-update.service || true

echo
echo "Done. Pushes to main now reach this machine within about a minute. Useful commands:"
echo "  journalctl -u hearthbeat-update -f                       # update log"
echo "  sudo systemctl disable --now hearthbeat-update.timer     # turn auto-update off"
