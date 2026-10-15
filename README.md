# servers-up

A Discord bot that watches World of Warcraft realm status through the Blizzard API. It posts when realms go down or come back up, and gives a heads-up before weekly maintenance.

## Alerts

All alerts go to one channel. If `PING_ROLE_ID` is set, every alert except "status unavailable" pings that role.

| Alert | When it posts |
| --- | --- |
| Region going down / coming back up | At least `MASS_CHANGE_THRESHOLD` of connected realms flip in one poll (maintenance, big outage). One message instead of hundreds. |
| All realms up | The last down realm in the region comes back. |
| Watched realm went down / came back up | A realm in `WATCH_REALMS` changes status. Notes if a login queue is active. |
| Weekly maintenance warning | `MAINT_WARN_MINUTES` before the regular maintenance window. Blizzard has no maintenance API, so this follows the usual schedule and is not a confirmed shutdown. |
| Realm status unavailable | Blizzard API requests fail 3 polls in a row. Posted once, then silent until a poll succeeds. |

The bot's own Discord status shows how many realms are up, e.g. "Watching 83/83 US realms up".

## Commands

| Command | What it does |
| --- | --- |
| `/status` | Region summary plus your watched realms. |
| `/status realm:<name>` | One realm (with autocomplete): status, population, queue, and the realms it's connected with. |
| `/testalert` | Posts a sample of each alert, marked as a test, to the alert channel. Needs the Manage Server permission. |

## Setup

Needs Node 18.17 or newer.

1. **Discord bot**: create an application at https://discord.com/developers/applications, add a Bot, and copy its token. Invite it with the `bot` and `applications.commands` scopes and the Send Messages and Embed Links permissions (OAuth2 URL Generator on the same page).
2. **Blizzard API client**: create one at https://develop.battle.net/access/clients and copy the client ID and secret.
3. **Channel ID**: in Discord, enable Developer Mode (User Settings > Advanced), then right-click the channel > Copy Channel ID. The same works for a server (`GUILD_ID`) and a role (`PING_ROLE_ID`).
4. **Configure and run**:

```bash
cp .env.example .env # fill in the values
npm install
npm start
```

## Configuration

Everything is set in `.env`. Only the first four are required.

| Variable | Default | What it does |
| --- | --- | --- |
| `DISCORD_TOKEN` | | Bot token. |
| `CHANNEL_ID` | | Channel the alerts are posted to. |
| `BLIZZARD_CLIENT_ID` | | Blizzard API client ID. |
| `BLIZZARD_CLIENT_SECRET` | | Blizzard API client secret. |
| `GUILD_ID` | none | Registers the commands in one server so they appear immediately. Without it they are global, which can take up to an hour. |
| `PING_ROLE_ID` | none | Role to ping on alerts. |
| `REGION` | `us` | `us`, `eu`, `kr` or `tw`. |
| `POLL_SECONDS` | `60` | How often to check realm status. Minimum 30. |
| `WATCH_REALMS` | none | Comma-separated realm slugs that get their own alerts, e.g. `area-52,illidan`. |
| `MASS_CHANGE_THRESHOLD` | `0.5` | Fraction of realms that must flip at once to count as region-wide. |
| `MAINT_DAY` | `2` | Maintenance day, 0 = Sunday to 6 = Saturday. |
| `MAINT_HOUR` | `7` | Maintenance hour (24h) in `MAINT_TZ`. |
| `MAINT_TZ` | `America/Los_Angeles` | Time zone for the maintenance window. Daylight saving is handled automatically. |
| `MAINT_WARN_MINUTES` | `60,15` | Minutes before maintenance to post warnings. Leave empty to disable. |

The maintenance defaults are for US (Tuesday 07:00 Pacific). For EU, use `MAINT_DAY=3`, `MAINT_HOUR=4` and `MAINT_TZ=Europe/Paris`.

## Keeping it running

Any always-on Linux machine with systemd works, such as a Raspberry Pi or a VPS. The install script sets the bot up as a service:

```bash
sudo apt update && sudo apt install -y git nodejs npm
node -v # needs v18.17 or newer
git clone https://github.com/lolswirl/servers-up.git
cd servers-up
npm ci --omit=dev
cp .env.example .env
nano .env # fill in your values, Ctrl+O to save, Ctrl+X to exit
bash scripts/install-service.sh
```

The service starts on boot and restarts itself if it crashes.

| Task | Command |
| --- | --- |
| Live logs | `journalctl -u servers-up -f` |
| Restart (after editing `.env`) | `sudo systemctl restart servers-up` |
| Update | `git pull && npm ci --omit=dev && sudo systemctl restart servers-up` |
| Stop | `sudo systemctl stop servers-up` |

### Automatic updates

To have the machine follow GitHub by itself, run this once:

```bash
bash scripts/install-autoupdate.sh
```

It adds a timer that checks `main` every minute. When there are new commits it resets the checkout to match GitHub, reinstalls dependencies, and restarts the bot. Local edits to tracked files are discarded; `.env` is left alone.

| Task | Command |
| --- | --- |
| Update log | `journalctl -u servers-up-update -f` |
| Turn off | `sudo systemctl disable --now servers-up-update.timer` |

## How it works

- Status comes from Blizzard's connected-realm search endpoint (`/data/wow/search/connected-realm`, `dynamic-<region>` namespace): one request per poll for the whole region. [API docs](https://develop.battle.net/documentation/world-of-warcraft/game-data-apis).
- The first poll after startup only records the current state, so restarting the bot never posts a burst of alerts.
- Polling every 60 seconds stays far under Blizzard's rate limits.
