#!/usr/bin/env bash
# Installs a systemd timer that checks GitHub every minute and, when main has new commits,
# updates this checkout and restarts servers-up. Run after install-service.sh.
# Run from the repo folder:  bash scripts/install-autoupdate.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
NODE_BIN="$(command -v node || true)"
UPDATER=/usr/local/bin/servers-up-update
SERVICE=/etc/systemd/system/servers-up-update.service
TIMER=/etc/systemd/system/servers-up-update.timer

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js not found. Install it first (see README)." >&2
  exit 1
fi

if [[ ! -f /etc/systemd/system/servers-up.service ]]; then
  echo "servers-up service not found. Run: bash scripts/install-service.sh  first." >&2
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
deployed="\$(cat .git/servers-up-deployed 2>/dev/null || true)"
[[ "\$target" == "\$deployed" ]] && exit 0

# Mirror GitHub exactly: local edits to tracked files are discarded, .env is untouched
as_user git reset --hard --quiet "\$target"
as_user npm ci --omit=dev
systemctl restart servers-up
echo "\$target" > .git/servers-up-deployed
echo "Updated servers-up to \${target:0:7}"
EOF
sudo chmod +x "$UPDATER"

sudo tee "$SERVICE" > /dev/null <<EOF
[Unit]
Description=Update servers-up from GitHub
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=$UPDATER
EOF

sudo tee "$TIMER" > /dev/null <<EOF
[Unit]
Description=Check GitHub for servers-up updates every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now servers-up-update.timer
sudo systemctl start servers-up-update.service || true
sudo systemctl --no-pager --lines=10 status servers-up-update.service || true

echo
echo "Done. Pushes to main now reach this machine within about a minute. Useful commands:"
echo "  journalctl -u servers-up-update -f                       # update log"
echo "  sudo systemctl disable --now servers-up-update.timer     # turn auto-update off"
