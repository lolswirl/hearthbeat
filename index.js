import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  ActivityType,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
} from 'discord.js';

// ---------- config ----------
const cfg = {
  token: req('DISCORD_TOKEN'),
  channelId: req('CHANNEL_ID'),
  guildId: process.env.GUILD_ID || null,
  clientId: req('BLIZZARD_CLIENT_ID'),
  clientSecret: req('BLIZZARD_CLIENT_SECRET'),
  region: (process.env.REGION || 'us').toLowerCase(),
  pollMs: Math.max(30, Number(process.env.POLL_SECONDS || 60)) * 1000,
  watch: (process.env.WATCH_REALMS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  massThreshold: Number(process.env.MASS_CHANGE_THRESHOLD || 0.5),
  maintDay: Number(process.env.MAINT_DAY ?? 2), // 0 = Sunday
  maintHour: Number(process.env.MAINT_HOUR ?? 7),
  maintTz: process.env.MAINT_TZ || 'America/Los_Angeles',
  maintWarn: (process.env.MAINT_WARN_MINUTES ?? '60,15')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0),
  pingRole: process.env.PING_ROLE_ID || null,
};

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}. See .env.example.`);
    process.exit(1);
  }
  return v;
}

const COLORS = { UP: 0x2ecc71, DOWN: 0xe74c3c, WARN: 0xf1c40f, INFO: 0x5865f2 };
const API = `https://${cfg.region}.api.blizzard.com`;
const NAMESPACE = `dynamic-${cfg.region}`;

// ---------- Blizzard API ----------
let token = null;
let tokenExpires = 0;

async function getToken() {
  if (token && Date.now() < tokenExpires - 60_000) return token;
  const res = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      Authorization:
        'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`OAuth failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  token = json.access_token;
  tokenExpires = Date.now() + json.expires_in * 1000;
  return token;
}

/**
 * Returns Map<connectedRealmId, { id, status: 'UP'|'DOWN', population, queue, realms: [{name, slug}] }>
 * Uses the connected-realm search endpoint so the whole region comes back in one or two calls.
 */
async function fetchRealms() {
  const t = await getToken();
  const out = new Map();
  let page = 1;
  let pageCount = 1;
  do {
    const url =
      `${API}/data/wow/search/connected-realm?namespace=${NAMESPACE}` +
      `&orderby=id&_pageSize=1000&_page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
    if (res.status === 401) {
      token = null; // force refresh next poll
      throw new Error('Blizzard token rejected (401)');
    }
    if (!res.ok) throw new Error(`Realm search failed: ${res.status}`);
    const json = await res.json();
    pageCount = json.pageCount || 1;
    for (const r of json.results || []) {
      const d = r.data;
      out.set(d.id, {
        id: d.id,
        status: d.status?.type || 'UNKNOWN',
        population: d.population?.name?.en_US || d.population?.type || '?',
        queue: !!d.has_queue,
        realms: (d.realms || []).map((x) => ({
          name: x.name?.en_US || x.slug,
          slug: x.slug,
        })),
      });
    }
    page++;
  } while (page <= pageCount);
  return out;
}

// ---------- state ----------
let last = null; // Map from previous poll
let lastOk = null; // Date of last successful poll
let apiFailing = false;
let lastPresence = null;

// Bot status in the member list: green = all up, yellow = some down, red = all down
function setPresence(text, status) {
  const key = `${status}|${text}`;
  if (!client.user || key === lastPresence) return;
  lastPresence = key;
  client.user.setPresence({
    status,
    activities: [{ name: text, type: ActivityType.Watching }],
  });
}

function presenceFromSummary(s) {
  const status = s.down === 0 ? 'online' : s.up === 0 ? 'dnd' : 'idle';
  setPresence(`${s.up}/${s.total} ${cfg.region.toUpperCase()} realms up`, status);
}

const label = (cr) => cr.realms.map((r) => r.name).join(', ');
const isWatched = (cr) => cr.realms.some((r) => cfg.watch.includes(r.slug));

function findRealm(query) {
  if (!last) return null;
  const q = query.trim().toLowerCase();
  const slugQ = q.replace(/['\s]+/g, '-');
  for (const cr of last.values()) {
    for (const r of cr.realms) {
      if (r.slug === slugQ || r.name.toLowerCase() === q) return { cr, realm: r };
    }
  }
  return null;
}

function summary(map) {
  let up = 0;
  let down = 0;
  for (const cr of map.values()) cr.status === 'UP' ? up++ : down++;
  return { up, down, total: map.size };
}

// ---------- alert embeds ----------
// Shared by the real alerts and /testalert so the two can't drift apart
const REGION = cfg.region.toUpperCase();
const counts = (s) => `🟢 **${s.up}** up · 🔴 **${s.down}** down`;

function realmAlert(cr, up) {
  // Title names only the watched realms; the rest of the connected group goes in the description
  const watched = cr.realms.filter((r) => cfg.watch.includes(r.slug));
  const shown = watched.length ? watched : cr.realms;
  const others = cr.realms.filter((r) => !shown.includes(r)).map((r) => r.name);
  const lines = [];
  if (others.length) lines.push(`Connected with ${others.join(', ')}`);
  if (up && cr.queue) lines.push('Login queue is active.');
  return new EmbedBuilder()
    .setColor(up ? COLORS.UP : COLORS.DOWN)
    .setTitle(`${up ? '🟢' : '🔴'} ${shown.map((r) => r.name).join(', ')} ${up ? 'came back up' : 'went down'}`)
    .setDescription(lines.join('\n') || null);
}

const alerts = {
  maintenance: (mins, at) =>
    new EmbedBuilder()
      .setColor(COLORS.WARN)
      .setTitle(`🟡 Weekly maintenance in ${mins} minutes`)
      .setDescription(
        `${REGION} realms usually go down at <t:${at}:t> (<t:${at}:R>).\n` +
          'This is the regular schedule, not a confirmed shutdown.'
      ),
  massDown: (n, s) =>
    new EmbedBuilder()
      .setColor(COLORS.DOWN)
      .setTitle(`🔴 ${REGION} realms are going down`)
      .setDescription(`**${n}** of **${s.total}** connected realms just went down.\n${counts(s)}`),
  massUp: (n, s) =>
    new EmbedBuilder()
      .setColor(COLORS.UP)
      .setTitle(`🟢 ${REGION} realms are coming back up`)
      .setDescription(`**${n}** of **${s.total}** connected realms just came up.\n${counts(s)}`),
  allUp: (s) =>
    new EmbedBuilder()
      .setColor(COLORS.UP)
      .setTitle(`🟢 All ${REGION} realms are up`)
      .setDescription(`All **${s.total}** connected realms are up.`),
  realmDown: (cr) => realmAlert(cr, false),
  realmUp: (cr) => realmAlert(cr, true),
  apiDown: (msg) =>
    new EmbedBuilder()
      .setColor(COLORS.WARN)
      .setTitle('🟡 Realm status unavailable')
      .setDescription(
        `Couldn't reach the Blizzard API, will keep retrying. This often happens during maintenance.\n\`${msg}\``
      ),
};

// ---------- Discord ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let channel = null;

async function post(embed, ping = false) {
  if (!channel) return;
  try {
    await channel.send({
      content: ping && cfg.pingRole ? `<@&${cfg.pingRole}>` : undefined,
      embeds: [embed],
      allowedMentions: { roles: cfg.pingRole ? [cfg.pingRole] : [] },
    });
  } catch (e) {
    console.error('Failed to post to Discord:', e.message);
  }
}

async function poll() {
  let now;
  try {
    now = await fetchRealms();
  } catch (e) {
    console.error(new Date().toISOString(), e.message);
    if (!apiFailing) {
      apiFailing = true;
      setPresence('Blizzard API unreachable', 'idle');
      await post(alerts.apiDown(e.message));
    }
    return;
  }

  if (apiFailing) {
    apiFailing = false;
    console.log('Blizzard API reachable again');
  }
  lastOk = new Date();

  if (!last) {
    last = now;
    const s = summary(now);
    console.log(`Seeded ${s.total} connected realms (${s.up} up, ${s.down} down)`);
    presenceFromSummary(s);
    return;
  }

  const wentDown = [];
  const cameUp = [];
  for (const [id, cr] of now) {
    const prev = last.get(id);
    if (!prev || prev.status === cr.status) continue;
    if (cr.status === 'DOWN') wentDown.push(cr);
    else if (cr.status === 'UP') cameUp.push(cr);
  }
  last = now;

  const total = now.size || 1;
  const s = summary(now);

  // Region-wide events (maintenance / big outage): one message instead of hundreds
  const massDown = wentDown.length / total >= cfg.massThreshold;
  const massUp = cameUp.length / total >= cfg.massThreshold;

  if (massDown) await post(alerts.massDown(wentDown.length, s), true);
  if (massUp) await post(alerts.massUp(cameUp.length, s), true);

  // Region fully recovered after a mass event that trickled back in
  if (!massUp && cameUp.length && s.down === 0) await post(alerts.allUp(s), true);

  // Individual watched realms always get their own message
  for (const cr of wentDown) {
    if (isWatched(cr)) await post(alerts.realmDown(cr), true);
  }
  for (const cr of cameUp) {
    if (isWatched(cr)) await post(alerts.realmUp(cr), true);
  }

  presenceFromSummary(s);

  if (wentDown.length || cameUp.length) {
    console.log(
      `${new Date().toISOString()} changes: ${wentDown.length} down, ${cameUp.length} up ` +
        `(${s.up}/${s.total} up)`
    );
  }
}

// ---------- weekly maintenance warning ----------
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const sentWarnings = new Set();

function minutesUntilMaintenance() {
  // Read the wall clock in the maintenance time zone, so DST is handled for us
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: cfg.maintTz,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  const nowMin = WEEKDAYS[parts.weekday] * 1440 + Number(parts.hour) * 60 + Number(parts.minute);
  const target = cfg.maintDay * 1440 + cfg.maintHour * 60;
  return (target - nowMin + 10080) % 10080; // minutes in a week
}

async function checkMaintenance() {
  if (!cfg.maintWarn.length) return;
  const mins = minutesUntilMaintenance();
  for (const w of cfg.maintWarn) {
    // key by week so each warning fires once per week
    const weekKey = `${w}-${Math.floor((Date.now() + mins * 60_000) / 86_400_000)}`;
    if (mins === w && !sentWarnings.has(weekKey)) {
      sentWarnings.add(weekKey);
      const at = Math.floor((Date.now() + mins * 60_000) / 60_000) * 60;
      await post(alerts.maintenance(w, at), true);
    }
  }
  if (sentWarnings.size > 50) sentWarnings.clear();
}

// ---------- slash command ----------
const testCommand = new SlashCommandBuilder()
  .setName('testalert')
  .setDescription('Post a sample of each alert type to the alert channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

function testEmbeds() {
  const { total } = last ? summary(last) : { total: 0 };
  const allDown = { up: 0, down: total, total };
  const allUp = { up: total, down: 0, total };
  const cr = (last && [...last.values()].find(isWatched)) || {
    queue: false,
    realms: [{ name: 'Example Realm', slug: 'example-realm' }],
  };
  const at = Math.floor(Date.now() / 1000) + 3600;
  return [
    alerts.maintenance(60, at),
    alerts.massDown(total, allDown),
    alerts.realmDown(cr),
    alerts.realmUp(cr),
    alerts.massUp(total, allUp),
    alerts.allUp(allUp),
    alerts.apiDown('example error'),
  ].map((e) => e.setTitle(`[TEST] ${e.data.title}`).setFooter({ text: 'TEST: not a real alert' }));
}

const statusCommand = new SlashCommandBuilder()
  .setName('status')
  .setDescription('WoW realm status')
  .addStringOption((o) =>
    o.setName('realm').setDescription('Realm name or slug (blank for region summary)').setAutocomplete(true)
  );

client.on('interactionCreate', async (i) => {
  try {
    if (i.isAutocomplete() && i.commandName === 'status') {
      const q = i.options.getFocused().toLowerCase();
      const names = [];
      if (last) for (const cr of last.values()) for (const r of cr.realms) names.push(r);
      const choices = names
        .filter((r) => r.name.toLowerCase().includes(q) || r.slug.includes(q))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 25)
        .map((r) => ({ name: r.name, value: r.slug }));
      return i.respond(choices);
    }

    if (i.isChatInputCommand() && i.commandName === 'testalert') {
      if (!channel) return i.reply({ content: 'Alert channel not ready yet.', ephemeral: true });
      try {
        await channel.send({ embeds: testEmbeds(), allowedMentions: { parse: [] } });
        return i.reply({ content: `Posted test alerts to <#${channel.id}>.`, ephemeral: true });
      } catch (e) {
        return i.reply({ content: `Couldn't post to <#${channel.id}>: ${e.message}`, ephemeral: true });
      }
    }

    if (!i.isChatInputCommand() || i.commandName !== 'status') return;

    if (!last) {
      return i.reply({ content: "I haven't fetched realm status yet, try again in a minute.", ephemeral: true });
    }

    const query = i.options.getString('realm');
    const footer = lastOk ? `Last checked` : null;

    if (!query) {
      const s = summary(last);
      const watched = [...last.values()].filter(isWatched);
      const embed = new EmbedBuilder()
        .setColor(s.down === 0 ? COLORS.UP : s.up === 0 ? COLORS.DOWN : COLORS.WARN)
        .setTitle(`${REGION} realm status`)
        .setDescription(`${counts(s)} · ${s.total} connected realms`)
        .setFooter(footer ? { text: footer } : null)
        .setTimestamp(lastOk);
      if (watched.length) {
        embed.addFields({
          name: 'Watched',
          value: watched
            .map((cr) => `${cr.status === 'UP' ? '🟢' : '🔴'} ${label(cr)}`)
            .join('\n')
            .slice(0, 1024),
        });
      }
      return i.reply({ embeds: [embed] });
    }

    const hit = findRealm(query);
    if (!hit) return i.reply({ content: `No realm matching "${query}".`, ephemeral: true });
    const { cr, realm } = hit;
    const others = cr.realms.filter((r) => r.slug !== realm.slug).map((r) => r.name);
    const embed = new EmbedBuilder()
      .setColor(cr.status === 'UP' ? COLORS.UP : COLORS.DOWN)
      .setTitle(`${cr.status === 'UP' ? '🟢' : '🔴'} ${realm.name} is ${cr.status === 'UP' ? 'up' : 'down'}`)
      .addFields(
        { name: 'Population', value: String(cr.population), inline: true },
        { name: 'Queue', value: cr.queue ? 'Yes' : 'No', inline: true }
      )
      .setFooter(footer ? { text: footer } : null)
      .setTimestamp(lastOk);
    if (others.length) embed.addFields({ name: 'Connected with', value: others.join(', ').slice(0, 1024) });
    return i.reply({ embeds: [embed] });
  } catch (e) {
    console.error('Interaction error:', e);
  }
});

// ---------- startup ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST().setToken(cfg.token);
  const body = [statusCommand.toJSON(), testCommand.toJSON()];
  const route = cfg.guildId
    ? Routes.applicationGuildCommands(client.user.id, cfg.guildId)
    : Routes.applicationCommands(client.user.id);
  await rest.put(route, { body });
  console.log(`Registered /status and /testalert ${cfg.guildId ? 'in guild' : 'globally'}`);

  channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel?.isTextBased()) {
    console.error(`CHANNEL_ID ${cfg.channelId} is not a text channel the bot can see.`);
    process.exit(1);
  }

  await poll();
  setInterval(poll, cfg.pollMs);
  setInterval(checkMaintenance, 30_000);
});

client.login(cfg.token);
