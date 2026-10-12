# servers-up

Discord bot that watches World of Warcraft realm status through the Blizzard API and posts when realms go down or come back up, plus a heads-up before weekly maintenance.

## What it posts

- **Region-wide down / up**: when at least `MASS_CHANGE_THRESHOLD` of connected realms flip in one poll (maintenance, big outage), one message instead of hundreds.
- **All realms up**: when the last down realm in the region comes back.
- **Watched realms**: realms listed in `WATCH_REALMS` get their own DOWN / UP message every time (notes if a login queue is active).
- **Maintenance warnings**: posted `MAINT_WARN_MINUTES` before the regular weekly maintenance window. This is schedule-based (Blizzard has no maintenance API), so it is labelled as "usually", not confirmed.
- **API unreachable**: one message if the Blizzard API stops responding, then silent until it recovers.

`/status` shows a region summary and your watched realms. `/status realm:<name>` shows one realm (with autocomplete), its population, queue, and which realms it's connected with.

## Setup

1. **Discord bot**: create an application at https://discord.com/developers/applications, add a Bot, copy its token. Invite it with the `bot` and `applications.commands` scopes and the Send Messages + Embed Links permissions (OAuth2 URL Generator in the same page).
2. **Blizzard API client**: create one at https://develop.battle.net/access/clients and copy the client ID and secret.
3. **Channel ID**: in Discord, enable Developer Mode (User Settings > Advanced), right-click the channel > Copy Channel ID. Same for `GUILD_ID` (right-click the server) and `PING_ROLE_ID` (right-click a role) if you want them.
4. Configure and run (Node 18+):

```bash
cp .env.example .env   # fill in the values
npm install
npm start
```

Set `GUILD_ID` so `/status` shows up immediately; global commands can take up to an hour to appear.

## Regions

`REGION=us|eu|kr|tw`. For EU, also change the maintenance window, e.g. `MAINT_DAY=3 MAINT_HOUR=4 MAINT_TZ=Europe/Paris`. `MAINT_DAY` is 0 = Sunday ... 6 = Saturday, in `MAINT_TZ` local time (DST handled automatically).

## Keeping it running

Any always-on box works: a VPS, a Raspberry Pi, or a host like Railway / Fly.io. With pm2:

```bash
npm i -g pm2
pm2 start index.js --name servers-up
pm2 save
```

### Raspberry Pi (systemd)

Needs a Pi 3, 4, 5 or Zero 2 W (Node.js no longer ships builds for the Pi 1 / original Zero) and Node 18.17+.

```bash
sudo apt update && sudo apt install -y git nodejs npm
node -v   # needs v18.17 or newer
git clone https://github.com/lolswirl/servers-up.git
cd servers-up
npm ci --omit=dev
cp .env.example .env
nano .env   # fill in your values, Ctrl+O to save, Ctrl+X to exit
bash scripts/install-service.sh
```

The service starts on boot and restarts itself if it crashes. Logs: `journalctl -u servers-up -f`. To update: `git pull && npm ci --omit=dev && sudo systemctl restart servers-up`.

## Notes

- Status comes from the connected-realm search endpoint (`/data/wow/search/connected-realm`, `dynamic-<region>` namespace), one request per poll for the whole region. Docs: https://develop.battle.net/documentation/world-of-warcraft/game-data-apis
- The first poll after startup only seeds state, so restarting the bot never spams messages.
- Polling minimum is 30 seconds; 60 is plenty and stays far under Blizzard's rate limits.
