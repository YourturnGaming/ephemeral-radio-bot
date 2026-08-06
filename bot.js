const {
  Client,
  GatewayIntentBits,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  InteractionContextType,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const log = require('./logger');

// ── Crash handling ─────────────────────────────────────────────────────────

// Transient network errors (DNS hiccups, dropped sockets) bubble up from the
// voice/WebSocket layer as uncaught exceptions. These are recoverable — the
// voice reconnect logic and ffmpeg's own -reconnect flags will heal them — so
// we must NOT exit the process for them, or a single DNS blip kills the bot.
const RECOVERABLE_NET_ERRORS = new Set([
  'EAI_AGAIN',     // temporary DNS resolution failure
  'ENOTFOUND',     // DNS lookup failed
  'ECONNRESET',    // connection reset by peer
  'ETIMEDOUT',     // connection timed out
  'ECONNREFUSED',  // connection refused
  'EPIPE',         // broken pipe
  'ENETUNREACH',   // network unreachable
  'EHOSTUNREACH',  // host unreachable
]);

function isRecoverableNetError(err) {
  return RECOVERABLE_NET_ERRORS.has(err?.code) ||
    /EAI_AGAIN|ENOTFOUND|ECONNRESET|getaddrinfo/i.test(err?.message ?? '');
}

// Kill the single shared ffmpeg child process. Called on shutdown and before any
// process.exit() so Pelican/Docker don't end up with an orphaned ffmpeg process.
function cleanupAllStreams() {
  if (globalFfmpeg) {
    try { globalFfmpeg.kill('SIGKILL'); } catch {}
    globalFfmpeg = null;
  }
}

process.on('SIGTERM', () => { cleanupAllStreams(); process.exit(0); });
process.on('SIGINT',  () => { cleanupAllStreams(); process.exit(0); });

process.on('uncaughtException', (err) => {
  if (isRecoverableNetError(err)) {
    log.warn(`Recoverable network error (ignored): ${err.message}`);
    return; // keep running; reconnect logic handles it
  }
  log.error(`Uncaught exception: ${err.stack ?? err.message}`);
  cleanupAllStreams();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  if (isRecoverableNetError(reason)) {
    log.warn(`Recoverable network rejection (ignored): ${reason?.message ?? reason}`);
    return;
  }
  log.error(`Unhandled rejection: ${reason?.stack ?? reason}`);
});

// ── Guild config persistence ───────────────────────────────────────────────
// Stores per-guild settings across restarts: announceChannelId, pingRoleId

const DATA_DIR    = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'guilds.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    log.error(`Failed to save guild config: ${err.message}`);
  }
}

// guildConfig: { [guildId]: { announceChannelId, pingRoleId } }
const guildConfig = loadConfig();

function getGuildConfig(guildId) {
  if (!guildConfig[guildId]) guildConfig[guildId] = { announceChannelId: null, pingRoleId: null };
  return guildConfig[guildId];
}

function persistGuildConfig(guildId, patch) {
  const cfg = getGuildConfig(guildId);
  Object.assign(cfg, patch);
  saveConfig(guildConfig);
}

// ── Live DJ DM subscribers ─────────────────────────────────────────────────
// Stored globally (not per-guild) because a DM isn't tied to a server — a user
// who subscribes anywhere gets exactly one DM per live set, even if they share
// several servers with the bot.

const SUBS_FILE = path.join(DATA_DIR, 'subscribers.json');

function loadSubscribers() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}

function saveSubscribers() {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify([...subscribers], null, 2));
  } catch (err) {
    log.error(`Failed to save subscribers: ${err.message}`);
  }
}

const subscribers = loadSubscribers();

// ── Use system ffmpeg if available, fall back to ffmpeg-static ─────────────
let ffmpegBin = 'ffmpeg';
try {
  const { execSync } = require('child_process');
  execSync('ffmpeg -version', { stdio: 'ignore' });
} catch {
  ffmpegBin = require('ffmpeg-static');
}

const STREAM_URL     = 'https://listen.ephemeral.club/listen/ephemeral/radio.mp3';
const NOWPLAYING_API = 'https://listen.ephemeral.club/api/nowplaying/ephemeral';
const SITE_URL       = 'https://ephemeral.club';
const GITHUB_URL     = 'https://github.com/YourturnGaming/ephemeral-radio-bot';
const LIVE_POLL_MS      = 30_000; // normal API poll interval
const LIVE_POLL_FAST_MS = 5_000;  // poll faster while the source is unreachable (to detect recovery)

// Stream restart backoff. When the source is down, spawning a fresh ffmpeg every
// couple of seconds hammers the server with connections that Icecast is slow to
// reap — inflating the listener count. Exponential backoff + an outage gate keeps
// reconnection attempts sparse until connectivity actually returns.
const RESTART_BASE_MS = 3_000;
const RESTART_MAX_MS  = 60_000;

// Shared outage flag — the single source of truth for "is the radio reachable".
// Driven by the API poll (same host, but the API doesn't count as a listener), so
// no component ever opens a stream connection just to test connectivity.
let streamReachable = true;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Per-guild runtime state: { connection, announceChannelId, songChannelId, voiceChannelId, rejoinAttempts }
// NOTE: there is no per-guild player/ffmpeg — all guilds share ONE global stream
// (see the Audio stream section) so the bot only opens a single connection to the
// radio source regardless of how many servers it streams to.
const guildState = new Map();

// The single shared audio pipeline. One ffmpeg → one AudioPlayer → fanned out to
// every guild's voice connection by @discordjs/voice itself.
let globalFfmpeg = null;
let globalPlayer = null;

// ── Live DJ detection ──────────────────────────────────────────────────────

// Live state is persisted so a restart doesn't read as a fresh set. Without it
// isLive resets to false on boot, the first poll sees `is_live && !isLive`, and
// every subscriber gets DMed about a set they were already told about. Restoring
// it also means that if the set ended while we were down, the first poll hits
// the `!is_live && isLive` branch instead and sends the end alert that was missed.

const LIVE_FILE = path.join(DATA_DIR, 'live.json');

function loadLiveState() {
  try {
    const saved = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8'));
    const state = { isLive: !!saved.isLive, liveStreamer: saved.liveStreamer ?? '' };
    if (state.isLive) {
      log.info(`Restored live state: ${state.liveStreamer || 'unknown DJ'} was live at shutdown (last saved ${saved.updatedAt ?? 'unknown'}).`);
    }
    return state;
  } catch {
    return { isLive: false, liveStreamer: '' };
  }
}

function saveLiveState() {
  try {
    fs.writeFileSync(
      LIVE_FILE,
      JSON.stringify({ isLive, liveStreamer, updatedAt: new Date().toISOString() }, null, 2),
    );
  } catch (err) {
    log.error(`Failed to save live state: ${err.message}`);
  }
}

const savedLive = loadLiveState();

let isLive        = savedLive.isLive;
let liveStreamer  = savedLive.liveStreamer;
let listenerCount = 0;

function updateStatus() {
  const listeners = listenerCount > 0 ? ` — 👥 ${listenerCount}` : '';
  if (isLive) {
    client.user?.setPresence({
      activities: [
        { name: 'Custom Status', type: ActivityType.Custom, state: `🎙️ LIVE: ${liveStreamer}${listeners} — ephemeral.club` },
        { name: `🎙️ LIVE: ${liveStreamer}`, type: ActivityType.Listening },
      ],
    });
  } else if (currentTitle) {
    client.user?.setPresence({
      activities: [
        { name: 'Custom Status', type: ActivityType.Custom, state: `🎵 ${currentTitle}${listeners} — ephemeral.club` },
        { name: currentTitle, type: ActivityType.Listening },
      ],
    });
  }
}

// Live DJ announcements — pings the configured role if set
function announce(message) {
  for (const [guildId, state] of guildState) {
    if (state.announceChannelId) {
      const channel = client.channels.cache.get(state.announceChannelId);
      const cfg = getGuildConfig(guildId);
      const content = cfg.pingRoleId ? `<@&${cfg.pingRoleId}> ${message}` : message;
      channel?.send(content).catch(() => {});
    }
  }
}

// Every subscriber DM carries a link to the site (Discord re-encodes voice audio,
// so the direct stream sounds noticeably better).
function listenButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Listen at ephemeral.club')
      .setStyle(ButtonStyle.Link)
      .setURL(SITE_URL)
      .setEmoji('🎧'),
  );
}

// Sends one payload to every subscriber, sequentially with a small gap to stay
// clear of Discord's DM rate limits. Users who have DMs closed (error 50007) are
// dropped from the list so we stop retrying them on every future alert.
async function dmSubscribers(payload, label) {
  if (subscribers.size === 0) return;

  const total = subscribers.size;
  let sent = 0;
  let pruned = 0;
  for (const userId of [...subscribers]) {
    try {
      const user = await client.users.fetch(userId);
      await user.send(payload);
      sent++;
    } catch (err) {
      if (err.code === 50007) { // cannot send DMs to this user
        subscribers.delete(userId);
        pruned++;
      } else {
        log.warn(`DM to ${userId} failed: ${err.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  if (pruned) saveSubscribers();
  log.info(`${label} DMs sent to ${sent}/${total} subscribers${pruned ? ` (${pruned} pruned: DMs closed)` : ''}.`);
}

// DM runs are queued, never run concurrently. A run takes ~250ms per subscriber,
// so with a decent subscriber list a short set can end while the "went live" run
// is still in flight — without serialising, the "set ended" DMs would interleave
// with, or even overtake, the ones announcing it started.
let dmQueue = Promise.resolve();

function queueDmRun(fn) {
  dmQueue = dmQueue
    .then(fn)
    .catch((err) => log.warn(`Subscriber DM run failed: ${err.message}`));
}

// DMs every subscriber that a DJ has gone live.
function notifyLive(streamerName) {
  queueDmRun(() => dmSubscribers({
    content:
      `🎙️ **${streamerName}** is now live on Ephemeral FM!\n\n` +
      `🎧 Listening in Discord works, but Discord compresses the audio — ` +
      `open the site below for full-quality sound.\n\n` +
      '-# To stop these alerts, run `/subscribe` again — in any server we share, or right here in this DM.',
    components: [listenButtonRow()],
  }, 'Live start'));
}

// ...and that the set has wrapped up. Subscribers only ever heard the start
// before, so a DJ going offline left the last DM in their inbox reading as if
// the set were still running.
function notifyLiveEnded(streamerName) {
  queueDmRun(() => dmSubscribers({
    content:
      `📻 **${streamerName}**'s set has ended — Ephemeral FM is back to regular programming.\n\n` +
      '-# To stop these alerts, run `/subscribe` again — in any server we share, or right here in this DM.',
    components: [listenButtonRow()],
  }, 'Live end'));
}

// Song change announcements — no role ping
function announceSong(message) {
  for (const [, state] of guildState) {
    if (state.songChannelId) {
      const channel = client.channels.cache.get(state.songChannelId);
      channel?.send(message).catch(() => {});
    }
  }
}

async function pollLiveStatus() {
  try {
    const res = await fetch(NOWPLAYING_API);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const { is_live, streamer_name } = data.live;

    listenerCount = data.listeners?.current ?? 0;

    // Source is reachable. If it just came back, rebuild voice connections (which
    // may be stale zombies after the outage) and restart the stream.
    if (!streamReachable) {
      streamReachable = true;
      log.info('Radio source reachable again.');
      rejoinAllGuilds();
      ensureStream();
    }

    if (is_live && !isLive) {
      isLive = true;
      liveStreamer = streamer_name;
      saveLiveState();
      log.info(`Live DJ started: ${streamer_name} (${listenerCount} listeners)`);
      updateStatus();
      announce(
        `🎙️ **${streamer_name}** is now live on Ephemeral FM!\n` +
        `🎧 For the best audio quality, listen direct at ${SITE_URL} — Discord compresses the stream.`
      );
      // Queued, not awaited: DMs are throttled and can take a while with many
      // subscribers, so don't hold up the poll loop waiting on them.
      notifyLive(streamer_name);
    } else if (!is_live && isLive) {
      // Captured before we clear it below. Falls back in case the API reported a
      // live set with no streamer_name — better than DMing everyone about "null".
      const endedStreamer = liveStreamer || 'The DJ';
      isLive = false;
      liveStreamer = '';
      saveLiveState();
      log.info(`Live DJ ended (${endedStreamer}), reverting to track metadata.`);
      updateStatus();
      announce(`📻 Live set ended — back to regular programming.`);
      notifyLiveEnded(endedStreamer);
    } else if (is_live && streamer_name && streamer_name !== liveStreamer) {
      // Still live, but a different DJ than we recorded — a back-to-back handover
      // with no gap, or a set that changed hands while the bot was down. Neither
      // transition branch fires here, so without this the status and the next end
      // alert would keep naming the previous DJ.
      log.info(`Live DJ changed: ${liveStreamer || 'unknown'} → ${streamer_name}`);
      liveStreamer = streamer_name;
      saveLiveState();
      updateStatus();
    } else {
      // Listener count may have changed even if live state didn't — refresh status
      updateStatus();
    }
  } catch (err) {
    if (streamReachable) {
      streamReachable = false;
      log.warn(`Radio source unreachable (${err.message}) — pausing stream restarts until it returns.`);
    }
  }
  // While unreachable, poll faster so recovery is detected quickly; otherwise relax.
  setTimeout(pollLiveStatus, streamReachable ? LIVE_POLL_MS : LIVE_POLL_FAST_MS);
}

// ── ICY metadata watcher ───────────────────────────────────────────────────

let currentTitle = null; // null until first metadata block arrives

function parseIcyTitle(metaStr) {
  const match = metaStr.match(/StreamTitle='([^']*)'/);
  return match ? match[1].trim() : null;
}

// Fetch the current title once from the stream (used at /play time)
function fetchCurrentTitle() {
  return new Promise((resolve) => {
    const parsed = new URL(STREAM_URL);
    const req = https.get(
      { hostname: parsed.hostname, path: parsed.pathname, headers: { 'Icy-MetaData': '1', 'User-Agent': 'EphemeralRadioBot/1.0' } },
      (res) => {
        const metaint = parseInt(res.headers['icy-metaint'], 10);
        if (!metaint) { res.destroy(); return resolve(null); }

        let bytesUntilMeta = metaint;
        let readingMeta = false;
        let metaLen = 0;
        let metaBuf = Buffer.alloc(0);

        res.on('data', (chunk) => {
          let pos = 0;
          while (pos < chunk.length) {
            if (!readingMeta) {
              const take = Math.min(bytesUntilMeta, chunk.length - pos);
              pos += take;
              bytesUntilMeta -= take;
              if (bytesUntilMeta === 0) { readingMeta = true; metaLen = 0; metaBuf = Buffer.alloc(0); }
            } else if (metaLen === 0) {
              metaLen = chunk[pos++] * 16;
              if (metaLen === 0) { readingMeta = false; bytesUntilMeta = metaint; }
            } else {
              const needed = metaLen - metaBuf.length;
              const take = Math.min(needed, chunk.length - pos);
              metaBuf = Buffer.concat([metaBuf, chunk.subarray(pos, pos + take)]);
              pos += take;
              if (metaBuf.length >= metaLen) {
                const title = parseIcyTitle(metaBuf.toString('utf8'));
                if (title) { res.destroy(); resolve(title); }
                readingMeta = false;
                bytesUntilMeta = metaint;
              }
            }
          }
        });

        res.on('error', () => resolve(null));
        res.on('close', () => resolve(null));
      }
    );
    req.on('error', () => resolve(null));
    setTimeout(() => { req.destroy(); resolve(null); }, 8_000);
  });
}

let icyReq = null;             // the current ICY request (single-flight)
let icyReconnectTimer = null;  // pending reconnect timer (never stacked)
let icyBackoff = 5_000;        // grows on repeated failure, resets on connect
const ICY_BACKOFF_MAX = 60_000;
const ICY_IDLE_TIMEOUT = 20_000; // destroy a stalled connection after 20s of no data

// Schedules exactly one backed-off ICY reconnect. Prevents the watcher from
// hammering the server (and leaving lingering half-open connections) during an
// outage — it used to blindly reconnect every 5s with no timeout.
function scheduleIcyReconnect() {
  if (icyReconnectTimer) return;
  const delay = icyBackoff;
  icyBackoff = Math.min(icyBackoff * 2, ICY_BACKOFF_MAX);
  icyReconnectTimer = setTimeout(() => {
    icyReconnectTimer = null;
    watchIcyMetadata();
  }, delay);
}

function watchIcyMetadata() {
  // Single-flight: tear down any prior request before opening a new one so we
  // never accumulate concurrent connections to the stream.
  if (icyReq) { try { icyReq.destroy(); } catch {} icyReq = null; }

  const parsed = new URL(STREAM_URL);
  const req = https.get(
    { hostname: parsed.hostname, path: parsed.pathname, headers: { 'Icy-MetaData': '1', 'User-Agent': 'EphemeralRadioBot/1.0' } },
    (res) => {
      const metaint = parseInt(res.headers['icy-metaint'], 10);
      if (!metaint) {
        res.destroy();
        return scheduleIcyReconnect();
      }
      icyBackoff = 5_000; // connected successfully — reset backoff

      let bytesUntilMeta = metaint;
      let readingMeta = false;
      let metaLen = 0;
      let metaBuf = Buffer.alloc(0);

      res.on('data', (chunk) => {
        let pos = 0;
        while (pos < chunk.length) {
          if (!readingMeta) {
            const take = Math.min(bytesUntilMeta, chunk.length - pos);
            pos += take;
            bytesUntilMeta -= take;
            if (bytesUntilMeta === 0) { readingMeta = true; metaLen = 0; metaBuf = Buffer.alloc(0); }
          } else if (metaLen === 0) {
            metaLen = chunk[pos++] * 16;
            if (metaLen === 0) { readingMeta = false; bytesUntilMeta = metaint; }
          } else {
            const needed = metaLen - metaBuf.length;
            const take = Math.min(needed, chunk.length - pos);
            metaBuf = Buffer.concat([metaBuf, chunk.subarray(pos, pos + take)]);
            pos += take;
            if (metaBuf.length >= metaLen) {
              const title = parseIcyTitle(metaBuf.toString('utf8'));
              if (title && title !== currentTitle) {
                currentTitle = title;
                log.info(`Now playing: ${title}`);
                if (!isLive) {
                  updateStatus();
                  announceSong(`🎵 Now playing: **${title}**`);
                }
              }
              readingMeta = false;
              bytesUntilMeta = metaint;
            }
          }
        }
      });

      res.on('end', scheduleIcyReconnect);
      res.on('error', scheduleIcyReconnect);
    }
  );
  icyReq = req;
  // Destroy a stalled/half-open connection instead of letting it linger (which
  // Icecast keeps counting as a listener) — then reconnect with backoff.
  req.setTimeout(ICY_IDLE_TIMEOUT, () => req.destroy(new Error('ICY idle timeout')));
  req.on('error', scheduleIcyReconnect);
}

// ── Audio stream ───────────────────────────────────────────────────────────

function createStream() {
  const ffmpeg = spawn(ffmpegBin, [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-timeout', '10000000', // 10s connection timeout — fail fast so idle handler can retry
    '-i', STREAM_URL,
    '-vn',
    '-ar', '48000',
    '-ac', '2',
    '-f', 's16le',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
  return { resource, ffmpeg };
}

// Kills the single shared ffmpeg process (if running).
function killStream() {
  if (globalFfmpeg) {
    globalFfmpeg.kill('SIGKILL');
    globalFfmpeg = null;
  }
}

// (Re)starts the shared stream: kills any existing ffmpeg, spawns a fresh one,
// and plays it on the global player. All subscribed guild connections receive it.
function startStream() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  killStream();
  const { resource, ffmpeg } = createStream();
  globalFfmpeg = ffmpeg;
  globalPlayer.play(resource);
}

// True if a real (non-bot) member is present in the given guild's voice channel.
function guildHasListeners(guildId) {
  const state = guildState.get(guildId);
  if (!state) return false;
  const channel = client.guilds.cache.get(guildId)?.channels?.cache?.get(state.voiceChannelId);
  return channel?.members?.some((m) => !m.user.bot) ?? false;
}

// True if at least one guild has a real listener in the bot's voice channel.
function anyListeners() {
  for (const [guildId] of guildState) {
    if (guildHasListeners(guildId)) return true;
  }
  return false;
}

// ── Stream supervisor (outage-aware, backed off) ───────────────────────────

let restartTimer = null;              // the single pending restart timer (never stacked)
let restartDelay = RESTART_BASE_MS;   // current backoff, grows on repeated failure
let healthyTimer = null;              // resets backoff after sustained playback

// Schedules exactly ONE backed-off stream (re)start. Guarantees a flapping or
// unreachable source can never queue a burst of ffmpeg spawns — the root cause of
// the listener-count spam during an outage.
function scheduleStreamRestart() {
  if (restartTimer) return;      // a restart is already pending — never stack them
  if (!anyListeners()) return;   // nobody listening — nothing to restart

  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!anyListeners()) return;

    if (!streamReachable) {
      // Source is down — do NOT spawn ffmpeg (that's what floods the server).
      // Just grow the backoff; the API poll will call ensureStream() on recovery.
      restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS);
      return;
    }

    if (globalPlayer.state.status === AudioPlayerStatus.Idle) {
      log.info(`Restarting stream (backoff ${restartDelay / 1000}s).`);
      startStream();
      restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS); // grow for next failure
    }
  }, restartDelay);
}

// Runs the shared stream only while at least one real listener is present in any
// guild's voice channel; otherwise stops it so the bot drops its radio connection
// while sitting idle in a channel 24/7. Idempotent — safe to call on every
// join/leave/rejoin/voiceStateUpdate/recovery.
function ensureStream() {
  if (!anyListeners()) {
    killStream();
    return;
  }
  if (globalPlayer.state.status !== AudioPlayerStatus.Idle) return; // already playing/buffering
  if (streamReachable) {
    startStream();
  } else {
    scheduleStreamRestart(); // wait for the source to come back
  }
}

// Create the one shared player up front and wire its lifecycle once.
globalPlayer = createAudioPlayer();
globalPlayer.on(AudioPlayerStatus.Idle, () => {
  // Resource ended/errored — schedule a backed-off restart if anyone's listening.
  clearTimeout(healthyTimer);
  scheduleStreamRestart();
});
globalPlayer.on(AudioPlayerStatus.Playing, () => {
  // Reset the backoff only after the stream has held for 30s, so a rapidly
  // flapping connection doesn't keep resetting it back to the base delay.
  clearTimeout(healthyTimer);
  healthyTimer = setTimeout(() => { restartDelay = RESTART_BASE_MS; }, 30_000);
});
globalPlayer.on('error', (err) => {
  log.error(`Shared player error: ${err.message}`);
  // The player transitions to Idle after an error, so the Idle handler above
  // performs the actual restart — just log here.
});

// Builds a fresh voice connection for a guild, subscribes it to the shared
// player, and waits until it's actually Ready. Throws if it never reaches Ready.
async function joinAndSubscribe(guildId, guild, forceChannelId = null) {
  const state = guildState.get(guildId);
  const g = guild ?? client.guilds.cache.get(guildId);

  // Prefer the channel the bot is *actually* in over our stored one. If an admin
  // just dragged the bot, a Disconnected event can fire before the
  // voiceStateUpdate handler adopts the new channel — using the live value stops
  // us rejoining the old channel and yanking the bot back. Falls back to the
  // stored channel when the bot isn't in one (e.g. it was kicked). An explicit
  // /move passes forceChannelId, which outranks both — the whole point of that
  // command is to go somewhere the bot currently isn't.
  const liveChannelId = g?.members?.me?.voice?.channelId;
  const channelId = forceChannelId ?? liveChannelId ?? state.voiceChannelId;
  if (channelId !== state.voiceChannelId) {
    state.voiceChannelId = channelId;
    persistGuildConfig(guildId, { voiceChannelId: channelId });
  }

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: g.voiceAdapterCreator,
    selfDeaf: false,
  });
  state.connection = connection;
  connection.subscribe(globalPlayer);
  attachDisconnectHandler(connection, guildId, g);
  // joinVoiceChannel() is synchronous — wait for real readiness so we never
  // declare success while the network is still down.
  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
}

// Moves the bot's voice connection to another channel in the same guild.
// Uses connection.rejoin() rather than joinVoiceChannel(): the latter hands back
// the SAME connection object for a guild that already has one, so we'd stack a
// second set of disconnect handlers on it and end up with duplicate rejoin loops.
async function moveToChannel(guildId, guild, channelId) {
  const state = guildState.get(guildId);

  // A rejoin loop may be mid-backoff (e.g. the bot was kicked moments ago). We're
  // about to establish the connection ourselves, so cancel it — otherwise it
  // fires later and drags the bot back to the channel it was aiming for.
  if (state.rejoinTimer) { clearTimeout(state.rejoinTimer); state.rejoinTimer = null; }
  state.rejoining = false;
  state.rejoinAttempts = 0;

  state.voiceChannelId = channelId;
  persistGuildConfig(guildId, { voiceChannelId: channelId });

  const connection = state.connection;
  if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
    // rejoin() returns false when the voice adapter couldn't send the state
    // update — fail fast instead of sitting out the full 15s entersState timeout.
    if (!connection.rejoin({ channelId, selfDeaf: false, selfMute: false })) {
      throw new Error('voice adapter unavailable');
    }
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } else {
    // No usable connection (kicked, or a recovery that gave up) — build a fresh one.
    await joinAndSubscribe(guildId, guild, channelId);
  }

  ensureStream(); // start if the new channel has listeners, go quiet if it's empty
}

// Entry point for recovering a lost voice connection. Guarded by state.rejoining
// so the error handler, Disconnected handler, and outage-recovery path can't spin
// up competing rejoin loops (which would create duplicate connections).
function scheduleRejoin(guildId, guild) {
  const state = guildState.get(guildId);
  if (!state) return;         // /stop was used, don't rejoin
  if (state.rejoining) return; // a rejoin loop is already running for this guild
  state.rejoining = true;
  state.rejoinAttempts = 0;
  attemptRejoin(guildId, guild);
}

// One iteration of the rejoin loop, with escalating backoff. Recurses on failure.
function attemptRejoin(guildId, guild) {
  const state = guildState.get(guildId);
  if (!state) return; // /stop was used

  state.rejoinAttempts++;
  const DELAYS = [5, 15, 30, 45, 60];
  const delay = (DELAYS[state.rejoinAttempts - 1] ?? 60) * 1_000;
  log.warn(`[${guildId}] Reconnecting voice in ${delay / 1000}s (attempt ${state.rejoinAttempts})`);

  state.rejoinTimer = setTimeout(async () => {
    const current = guildState.get(guildId);
    if (!current) return; // /stop was used while waiting

    try {
      await joinAndSubscribe(guildId, guild);
      current.rejoinAttempts = 0;
      current.rejoining = false;
      current.rejoinTimer = null;
      ensureStream();
      log.info(`[${guildId}] Successfully rejoined voice channel.`);
    } catch (err) {
      log.warn(`[${guildId}] Rejoin failed: ${err.message} — will retry.`);
      if (current.connection?.state?.status !== VoiceConnectionStatus.Destroyed) {
        current.connection?.destroy();
      }
      attemptRejoin(guildId, guild); // keep looping (rejoining stays true)
    }
  }, delay);
}

// Called when the radio source comes back after an outage. A network drop can
// leave a voice connection as a stale "Ready" zombie — dead UDP path, but no
// Disconnected event ever fires, so the normal rejoin path never triggers and
// audio silently stops. So we proactively rebuild every guild's connection.
async function rejoinAllGuilds() {
  for (const [guildId, state] of guildState) {
    if (state.rejoining) continue; // a backoff loop is already recovering this guild
    state.rejoining = true;
    if (state.rejoinTimer) { clearTimeout(state.rejoinTimer); state.rejoinTimer = null; }
    try {
      try { state.connection?.destroy(); } catch {}
      await joinAndSubscribe(guildId, client.guilds.cache.get(guildId));
      state.rejoinAttempts = 0;
      state.rejoining = false;
      log.info(`[${guildId}] Rebuilt voice connection after outage.`);
      ensureStream();
    } catch (err) {
      log.warn(`[${guildId}] Post-outage rebuild failed: ${err.message} — retrying with backoff.`);
      state.rejoining = false;         // release the guard so scheduleRejoin can take over
      scheduleRejoin(guildId, client.guilds.cache.get(guildId));
    }
  }
}

// Attaches recovery logic to a voice connection. Re-usable so that a connection
// created during a rejoin gets the SAME handler (the old code emitted a dead
// 'disconnected' event here, so a second disconnect was never handled).
function attachDisconnectHandler(connection, guildId, guild) {
  // Catch errors emitted directly on the connection (e.g. EAI_AGAIN on the UDP
  // socket during a voice-server migration). Without this listener, the error
  // becomes an uncaughtException that the global handler silently swallows —
  // the voice library's state machine never transitions to Disconnected, so the
  // handler below never fires and the bot is left with a silently broken
  // connection that streams to nobody.
  connection.on('error', (err) => {
    log.warn(`[${guildId}] Voice connection error: ${err.message}`);
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
    // Don't touch the shared stream — other guilds may still be listening. The
    // guild stays in guildState so scheduleRejoin can reconnect it.
    scheduleRejoin(guildId, guild);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    // Pre-silence both entersState promises so that whichever one Promise.race
    // doesn't consume doesn't produce an unhandled rejection later.
    const p1 = entersState(connection, VoiceConnectionStatus.Signalling, 5_000);
    const p2 = entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
    p1.catch(() => {});
    p2.catch(() => {});
    try {
      // First try to recover a brief network blip
      await Promise.race([p1, p2]);
      // Recovered on its own — nothing more to do.
    } catch {
      // If already destroyed (e.g. by the error handler above), skip to avoid
      // a double rejoin.
      if (connection.state.status === VoiceConnectionStatus.Destroyed) return;
      // Recovery failed — bot was likely kicked/moved. Try to rejoin.
      connection.destroy();
      // Don't touch the shared stream — other guilds may still be listening.
      scheduleRejoin(guildId, guild);
    }
  });
}

// ── Slash commands ─────────────────────────────────────────────────────────

// Commands that need a server (voice channels, per-guild config) are restricted
// to the Guild context so they don't clutter the bot's DM command list. Only the
// user-scoped commands (/subscribe, /help) are usable in DMs.
const GUILD_ONLY = [InteractionContextType.Guild];
const GUILD_AND_DM = [InteractionContextType.Guild, InteractionContextType.BotDM];

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Join your voice channel and stream Ephemeral FM')
    .setContexts(GUILD_ONLY),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop the stream and leave the voice channel')
    .setContexts(GUILD_ONLY),
  // Locked down two ways: setDefaultMemberPermissions hides it from members
  // without Move Members (server owners can re-grant it per-role in Integrations
  // settings), and the handler re-checks at runtime as a backstop.
  new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move the bot to another voice channel — defaults to yours (Move Members required)')
    .addChannelOption((opt) =>
      opt.setName('channel')
        .setDescription('Voice channel to move to — leave blank to bring the bot to you')
        .addChannelTypes(ChannelType.GuildVoice)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .setContexts(GUILD_ONLY),
  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show what is currently playing on Ephemeral FM')
    .setContexts(GUILD_ONLY),
  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Toggle live DJ announcements in this channel')
    .setContexts(GUILD_ONLY),
  new SlashCommandBuilder()
    .setName('songs')
    .setDescription('Toggle song change announcements in this channel')
    .setContexts(GUILD_ONLY),
  new SlashCommandBuilder()
    .setName('setrole')
    .setDescription('Set (or clear) the role to ping on song/live announcements (Manage Server required)')
    .addRoleOption((opt) =>
      opt.setName('role')
        .setDescription('Role to ping — leave blank to clear')
        .setRequired(false)
    )
    .setContexts(GUILD_ONLY),
  new SlashCommandBuilder()
    .setName('subscribe')
    .setDescription('Toggle DM alerts when a DJ goes live on Ephemeral FM')
    .setContexts(GUILD_AND_DM),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show what this bot can do and how to use it')
    .setContexts(GUILD_AND_DM),
].map((c) => c.toJSON());

// ── Bot events ─────────────────────────────────────────────────────────────

client.once('clientReady', async () => {
  log.info(`Logged in as ${client.user.tag}`);
  log.info(`Ephemeral Bot is Ready!`);

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    log.info('Slash commands registered.');
  } catch (err) {
    log.error(`Failed to register commands: ${err.message}`);
  }

  watchIcyMetadata();

  // Auto-rejoin any voice channels the bot was in before restart. Run in
  // parallel: sequentially, one unreachable guild burns its full 15s entersState
  // timeout before the next even starts, and the live poll below waits on all of
  // it. In parallel the whole loop is bounded by the slowest single guild.
  await Promise.all(Object.entries(guildConfig).map(async ([guildId, cfg]) => {
    if (!cfg.voiceChannelId) return;
    try {
      const guild = await client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(cfg.voiceChannelId);
      if (!channel?.isVoiceBased()) return;

      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      connection.subscribe(globalPlayer);
      guildState.set(guildId, {
        connection,
        announceChannelId: cfg.announceChannelId ?? null,
        songChannelId: cfg.songChannelId ?? null,
        voiceChannelId: channel.id,
        rejoinAttempts: 0,
        rejoining: false,
        rejoinTimer: null,
      });

      attachDisconnectHandler(connection, guildId, guild);
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      ensureStream();
      log.info(`[${guild.name}] Auto-rejoined #${channel.name} after restart.`);
    } catch (err) {
      log.warn(`[${guildId}] Auto-rejoin failed: ${err.message}`);
    }
  }));

  // Started only after the rejoins settle. The first poll can fire a live-state
  // transition (a set that ended while the bot was down), and announce() reads
  // guildState — which the loop above is what populates. Polling first meant that
  // announcement went to an empty map and was silently dropped, while the DM for
  // the same event still went out.
  pollLiveStatus();
});

client.on('interactionCreate', async (interaction) => {
  // ── Subscription buttons (sent in DMs) ─────────────────────────────────
  if (interaction.isButton()) {
    if (interaction.customId === 'sub:cancel') {
      subscribers.delete(interaction.user.id);
      saveSubscribers();
      log.info(`${interaction.user.tag} unsubscribed via button (${subscribers.size} total).`);
      // Strip the buttons so the message can't be clicked twice.
      await interaction.update({
        content:
          '🔕 **Unsubscribed** — you will not get DMs when a DJ goes live.\n' +
          '-# Changed your mind? Run `/subscribe` again — in any server we share, or right here in this DM.',
        components: [],
      });
    } else if (interaction.customId === 'sub:keep') {
      await interaction.update({
        content:
          "🔔 **You're all set** — I'll DM you whenever a DJ goes live on Ephemeral FM.\n" +
          '-# Want to stop later? Run `/subscribe` again — in any server we share, or right here in this DM.',
        components: [],
      });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, guild, member } = interaction;
  log.info(`[${guild?.name ?? (guildId ? guildId : 'DM')}] @${interaction.user.tag} used /${commandName}`);

  // ── /play ──────────────────────────────────────────────────────────────
  if (commandName === 'play') {
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: 'You need to be in a voice channel first.', ephemeral: true });
    }

    await interaction.deferReply();

    if (guildState.has(guildId)) {
      // Re-invoking /play in a guild that's already set up — drop the old
      // connection but leave the shared stream alone (other guilds need it).
      guildState.get(guildId).connection.destroy();
      guildState.delete(guildId);
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    connection.subscribe(globalPlayer);
    persistGuildConfig(guildId, { voiceChannelId: voiceChannel.id });
    guildState.set(guildId, {
      connection,
      announceChannelId: getGuildConfig(guildId).announceChannelId ?? null,
      songChannelId: getGuildConfig(guildId).songChannelId ?? null,
      voiceChannelId: voiceChannel.id,
      rejoinAttempts: 0,
      rejoining: false,
      rejoinTimer: null,
    });

    attachDisconnectHandler(connection, guildId, guild);

    ensureStream();

    // Always fetch fresh title at play time so it's never stale
    const title = await fetchCurrentTitle() ?? currentTitle ?? 'Ephemeral FM';
    currentTitle = title;

    const nowLine = isLive
      ? `🎙️ LIVE: **${liveStreamer}**\n🎵 ${title}`
      : `🎵 ${title}`;

    const listenersLine = listenerCount > 0 ? `\n👥 **${listenerCount}** listeners` : '';
    await interaction.editReply(
      `Now streaming **Ephemeral FM** in **${voiceChannel.name}**\n${nowLine}${listenersLine}`
    );
  }

  // ── /stop ──────────────────────────────────────────────────────────────
  if (commandName === 'stop') {
    if (!guildState.has(guildId)) {
      return interaction.reply({ content: 'Not currently streaming.', ephemeral: true });
    }
    const stopping = guildState.get(guildId);
    stopping.connection.destroy();
    guildState.delete(guildId);
    persistGuildConfig(guildId, { voiceChannelId: null });
    // If that was the last guild listening, stop the shared stream entirely so
    // the bot stops being a listener on the radio source.
    ensureStream();
    await interaction.reply('Stopped streaming and left the voice channel.');
  }

  // ── /move ──────────────────────────────────────────────────────────────
  if (commandName === 'move') {
    // Move Members is the Discord-native permission for dragging someone between
    // voice channels; Manage Server is accepted too so the people who already
    // configure the bot via /setrole can move it without a second role grant.
    const canMove = interaction.memberPermissions?.has(PermissionFlagsBits.MoveMembers)
      || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!canMove) {
      return interaction.reply({ content: 'You need the **Move Members** or **Manage Server** permission to use this command.', ephemeral: true });
    }

    const state = guildState.get(guildId);
    if (!state) {
      return interaction.reply({ content: 'The bot is not currently streaming. Use `/play` first.', ephemeral: true });
    }

    // No channel given → "follow me": bring the bot to the caller's channel.
    const target = interaction.options.getChannel('channel') ?? member?.voice?.channel;
    if (!target) {
      return interaction.reply({ content: 'Join a voice channel first, or pick one with the `channel` option.', ephemeral: true });
    }
    // Stage channels join as a suppressed audience member, so the bot would sit
    // there streaming to nobody — reject them rather than fail silently.
    if (target.type !== ChannelType.GuildVoice) {
      return interaction.reply({ content: 'That is not a regular voice channel — stage channels are not supported.', ephemeral: true });
    }
    if (target.id === state.voiceChannelId) {
      return interaction.reply({ content: `Already streaming in **${target.name}**.`, ephemeral: true });
    }

    // Checked up front so a missing permission reads as a clear message instead
    // of a connection that silently never reaches Ready.
    const perms = guild?.members?.me ? target.permissionsFor(guild.members.me) : null;
    if (!perms?.has(PermissionFlagsBits.Connect) || !perms.has(PermissionFlagsBits.Speak)) {
      return interaction.reply({ content: `I need **Connect** and **Speak** in **${target.name}** to stream there.`, ephemeral: true });
    }

    await interaction.deferReply();
    try {
      await moveToChannel(guildId, guild, target.id);
      log.info(`[${guild?.name ?? guildId}] Moved to #${target.name} by ${interaction.user.tag}`);
      await interaction.editReply(`📻 Moved to **${target.name}**.`);
    } catch (err) {
      log.warn(`[${guildId}] Move to #${target.name} failed: ${err.message}`);
      scheduleRejoin(guildId, guild); // hand recovery back to the normal backoff loop
      await interaction.editReply(`❌ Couldn't reach **${target.name}** (${err.message}) — retrying in the background.`);
    }
  }

  // ── /nowplaying ────────────────────────────────────────────────────────
  if (commandName === 'nowplaying') {
    const trackLine = isLive
      ? `🎙️ LIVE: **${liveStreamer}**\n🎵 ${currentTitle ?? 'Ephemeral FM'}`
      : `🎵 ${currentTitle ?? 'Ephemeral FM'}`;
    const listenersLine = listenerCount > 0 ? `\n👥 **${listenerCount}** listeners` : '';
    await interaction.reply(`${trackLine}${listenersLine}`);
  }

  // ── /announce ──────────────────────────────────────────────────────────
  if (commandName === 'announce') {
    const state = guildState.get(guildId);
    if (!state) {
      return interaction.reply({ content: 'The bot is not currently streaming. Use `/play` first.', ephemeral: true });
    }

    if (state.announceChannelId === interaction.channelId) {
      state.announceChannelId = null;
      persistGuildConfig(guildId, { announceChannelId: null });
      await interaction.reply({ content: '🔕 Live DJ announcements turned **off**.', ephemeral: true });
    } else {
      state.announceChannelId = interaction.channelId;
      persistGuildConfig(guildId, { announceChannelId: interaction.channelId });
      await interaction.reply({ content: `🔔 Live DJ announcements turned **on** in this channel.`, ephemeral: true });
    }
  }

  // ── /songs ────────────────────────────────────────────────────────────
  if (commandName === 'songs') {
    const state = guildState.get(guildId);
    if (!state) {
      return interaction.reply({ content: 'The bot is not currently streaming. Use `/play` first.', ephemeral: true });
    }

    if (state.songChannelId === interaction.channelId) {
      state.songChannelId = null;
      persistGuildConfig(guildId, { songChannelId: null });
      await interaction.reply({ content: '🔕 Song announcements turned **off**.', ephemeral: true });
    } else {
      state.songChannelId = interaction.channelId;
      persistGuildConfig(guildId, { songChannelId: interaction.channelId });
      await interaction.reply({ content: '🎵 Song announcements turned **on** in this channel.', ephemeral: true });
    }
  }

  // ── /setrole ───────────────────────────────────────────────────────────
  if (commandName === 'setrole') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: 'You need the **Manage Server** permission to use this command.', ephemeral: true });
    }

    const role = interaction.options.getRole('role');
    if (role) {
      persistGuildConfig(guildId, { pingRoleId: role.id });
      log.info(`[${guild?.name ?? guildId}] Ping role set to @${role.name} by ${interaction.user.tag}`);
      await interaction.reply({ content: `🔔 Announcement pings set to ${role}. This role will be mentioned on song and live DJ changes.`, ephemeral: true });
    } else {
      persistGuildConfig(guildId, { pingRoleId: null });
      log.info(`[${guild?.name ?? guildId}] Ping role cleared by ${interaction.user.tag}`);
      await interaction.reply({ content: '🔕 Announcement pings cleared — no role will be pinged.', ephemeral: true });
    }
  }

  // ── /help ──────────────────────────────────────────────────────────────
  if (commandName === 'help') {
    const inDm = !guildId;

    const lines = [
      '**📻 Ephemeral Radio Bot**',
      `Streams [Ephemeral FM](${SITE_URL}) into your voice channels, with live track info.`,
      '',
      '**Listening**',
      '`/play` — join your voice channel and start streaming',
      '`/stop` — stop streaming and leave the channel',
      '`/nowplaying` — show the current track and listener count',
      '',
      '**Alerts**',
      '`/subscribe` — DM you whenever a DJ goes live *(works in DMs too)*',
      '`/announce` — post live DJ alerts in this channel',
      '`/songs` — post every song change in this channel',
      '',
      '**Admin**',
      '`/move` — bring the bot to your voice channel, or pass one to send it there *(Move Members)*',
      '`/setrole` — pick a role to ping on live DJ alerts. Leave the option blank to clear it. *(Manage Server)*',
      '',
      '-# 🎧 Discord compresses audio — listen at ephemeral.club for full quality.',
    ];

    if (inDm) {
      lines.splice(
        lines.length - 1,
        0,
        "-# You're in a DM, so only `/subscribe` and `/help` are available here. The rest work in a server.",
      );
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('GitHub')
        .setStyle(ButtonStyle.Link)
        .setURL(GITHUB_URL)
        .setEmoji('📖'),
      new ButtonBuilder()
        .setLabel('Listen at ephemeral.club')
        .setStyle(ButtonStyle.Link)
        .setURL(SITE_URL)
        .setEmoji('🎧'),
    );

    await interaction.reply({ content: lines.join('\n'), components: [row], ephemeral: true });
  }

  // ── /subscribe ─────────────────────────────────────────────────────────
  if (commandName === 'subscribe') {
    const userId = interaction.user.id;

    if (subscribers.has(userId)) {
      subscribers.delete(userId);
      saveSubscribers();
      log.info(`${interaction.user.tag} unsubscribed from live DM alerts (${subscribers.size} total).`);
      return interaction.reply({
        content: '🔕 **Unsubscribed** — you will no longer get DMs when a DJ goes live.\n-# Changed your mind? Just run `/subscribe` again.',
        ephemeral: true,
      });
    }

    // Confirm we can actually DM them before saving — otherwise they'd silently
    // never receive alerts and assume the bot was broken. The buttons give them
    // a one-click way out if they change their mind.
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('sub:keep')
        .setLabel('Keep alerts')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🔔'),
      new ButtonBuilder()
        .setCustomId('sub:cancel')
        .setLabel('Unsubscribe')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔕'),
    );

    try {
      await interaction.user.send({
        content:
          "🔔 **You're subscribed to Ephemeral FM live alerts!**\n" +
          "I'll send you a DM here whenever a DJ goes live.\n\n" +
          'Having second thoughts? Hit **Unsubscribe** below.\n' +
          '-# You can also toggle alerts any time with `/subscribe` — in any server we share, or right here in this DM.',
        components: [row],
      });
    } catch {
      return interaction.reply({
        content: "❌ I couldn't DM you. Enable **Direct Messages** for this server (Server Settings → Privacy Settings) and try again.",
        ephemeral: true,
      });
    }

    subscribers.add(userId);
    saveSubscribers();
    log.info(`${interaction.user.tag} subscribed to live DM alerts (${subscribers.size} total).`);
    await interaction.reply({ content: '🔔 Subscribed! Check your DMs — I just sent a confirmation.', ephemeral: true });
  }
});

// Start/stop the shared stream based on whether real users are in the bot's
// voice channel. The bot stays connected 24/7 but only consumes the radio
// stream while someone is actually listening.
client.on('voiceStateUpdate', (oldState, newState) => {
  const guildId = (newState.guild ?? oldState.guild)?.id;
  if (!guildId || !guildState.has(guildId)) return;
  const state = guildState.get(guildId);

  // ── The bot's own voice state changed ─────────────────────────────────
  if (newState.id === client.user.id) {
    // An admin dragged the bot to another channel. Follow it: adopt the new
    // channel as ours so the listener check and any future rejoin target the
    // right place. Without this the stored channel goes stale, the listener
    // check inspects the OLD (now empty) channel, and the stream gets killed.
    if (newState.channelId && newState.channelId !== state.voiceChannelId) {
      const from = oldState.channelId;
      state.voiceChannelId = newState.channelId;
      persistGuildConfig(guildId, { voiceChannelId: newState.channelId });
      log.info(`[${newState.guild?.name ?? guildId}] Moved ${from ? `from ${from} ` : ''}to ${newState.channelId} — following.`);
      ensureStream(); // start if the new channel has listeners; no-op if already playing
    }
    // channelId === null means fully disconnected — the connection's own
    // Disconnected/error handlers own that recovery path, so nothing to do here.
    return;
  }

  if (newState.member?.user?.bot) return; // ignore other bots joining/leaving

  // Only react when the change involves the bot's channel (someone joined or left it).
  if (oldState.channelId !== state.voiceChannelId && newState.channelId !== state.voiceChannelId) return;

  ensureStream();
});

client.login(process.env.BOT_TOKEN);
