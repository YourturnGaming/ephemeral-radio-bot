const {
  Client,
  GatewayIntentBits,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
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
const LIVE_POLL_MS   = 30_000;

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

let isLive        = false;
let liveStreamer   = '';
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

    if (is_live && !isLive) {
      isLive = true;
      liveStreamer = streamer_name;
      log.info(`Live DJ started: ${streamer_name} (${listenerCount} listeners)`);
      updateStatus();
      announce(`🎙️ **${streamer_name}** is now live on Ephemeral FM!`);
    } else if (!is_live && isLive) {
      isLive = false;
      liveStreamer = '';
      log.info('Live DJ ended, reverting to track metadata.');
      updateStatus();
      announce(`📻 Live set ended — back to regular programming.`);
    } else {
      // Listener count may have changed even if live state didn't — refresh status
      updateStatus();
    }
  } catch (err) {
    log.warn(`Live poll failed: ${err.message}`);
  }
  setTimeout(pollLiveStatus, LIVE_POLL_MS);
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

function watchIcyMetadata() {
  const parsed = new URL(STREAM_URL);
  const req = https.get(
    { hostname: parsed.hostname, path: parsed.pathname, headers: { 'Icy-MetaData': '1', 'User-Agent': 'EphemeralRadioBot/1.0' } },
    (res) => {
      const metaint = parseInt(res.headers['icy-metaint'], 10);
      if (!metaint) {
        res.destroy();
        return setTimeout(watchIcyMetadata, 10_000);
      }

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

      res.on('end', () => setTimeout(watchIcyMetadata, 5_000));
      res.on('error', () => setTimeout(watchIcyMetadata, 5_000));
    }
  );
  req.on('error', () => setTimeout(watchIcyMetadata, 5_000));
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

// Runs the shared stream only while at least one real listener is present in any
// guild's voice channel; otherwise stops it so the bot drops its radio connection
// while sitting idle in a channel 24/7. Idempotent — safe to call on every
// join/leave/rejoin/voiceStateUpdate.
function ensureStream() {
  if (!anyListeners()) {
    killStream();
    return;
  }
  // Start only if the player is idle (no active resource). If it's already
  // Playing/Buffering, a newly subscribed connection just joins the existing feed.
  if (globalPlayer.state.status === AudioPlayerStatus.Idle) {
    startStream();
  }
}

// Create the one shared player up front and wire its lifecycle once.
globalPlayer = createAudioPlayer();
globalPlayer.on(AudioPlayerStatus.Idle, () => {
  // Resource ended/errored. Restart shortly if anyone is still listening.
  if (guildState.size > 0) setTimeout(ensureStream, 2_000);
});
globalPlayer.on('error', (err) => {
  log.error(`Shared player error: ${err.message}`);
  // The player transitions to Idle after an error, so the Idle handler above
  // performs the actual restart — just log here.
});

// Schedules a rejoin attempt for a guild whose voice connection has been lost.
// Shared by both the error handler and the Disconnected handler so both paths
// use the same backoff/retry logic.
function scheduleRejoin(guildId, guild) {
  const state = guildState.get(guildId);
  if (!state) return; // /stop was used, don't rejoin

  state.rejoinAttempts++;
  const DELAYS = [5, 15, 30, 45, 60];
  const delay = (DELAYS[state.rejoinAttempts - 1] ?? 60) * 1_000;
  log.warn(`[${guildId}] Disconnected, rejoining in ${delay / 1000}s (attempt ${state.rejoinAttempts})`);

  setTimeout(async () => {
    const current = guildState.get(guildId);
    if (!current) return; // /stop was used while waiting

    try {
      const g = guild ?? client.guilds.cache.get(guildId);
      const newConnection = joinVoiceChannel({
        channelId: current.voiceChannelId,
        guildId,
        adapterCreator: g.voiceAdapterCreator,
        selfDeaf: false,
      });
      current.connection = newConnection;
      newConnection.subscribe(globalPlayer);
      attachDisconnectHandler(newConnection, guildId, g);

      // Wait for the connection to actually be ready before declaring success.
      // joinVoiceChannel() is synchronous — without this the success log fires
      // immediately even when the network is still down.
      await entersState(newConnection, VoiceConnectionStatus.Ready, 15_000);

      current.rejoinAttempts = 0;
      // The shared stream is likely already playing (other guilds keep it alive);
      // ensureStream only (re)starts it if it had stopped while this was the last guild.
      ensureStream();
      log.info(`[${guildId}] Successfully rejoined voice channel.`);
    } catch (err) {
      log.warn(`[${guildId}] Rejoin failed: ${err.message} — will retry.`);
      // Destroy the partial connection if it wasn't already, then let
      // scheduleRejoin try the next attempt (state is preserved so the
      // attempt counter and backoff keep incrementing correctly).
      if (current.connection?.state?.status !== VoiceConnectionStatus.Destroyed) {
        current.connection?.destroy();
      }
      scheduleRejoin(guildId, guild);
    }
  }, delay);
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

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Join your voice channel and stream Ephemeral FM'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop the stream and leave the voice channel'),
  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show what is currently playing on Ephemeral FM'),
  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Toggle live DJ announcements in this channel'),
  new SlashCommandBuilder()
    .setName('songs')
    .setDescription('Toggle song change announcements in this channel'),
  new SlashCommandBuilder()
    .setName('setrole')
    .setDescription('Set (or clear) the role to ping on song/live announcements (Manage Server required)')
    .addRoleOption((opt) =>
      opt.setName('role')
        .setDescription('Role to ping — leave blank to clear')
        .setRequired(false)
    ),
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
  pollLiveStatus();

  // Auto-rejoin any voice channels the bot was in before restart
  for (const [guildId, cfg] of Object.entries(guildConfig)) {
    if (!cfg.voiceChannelId) continue;
    try {
      const guild = await client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(cfg.voiceChannelId);
      if (!channel?.isVoiceBased()) continue;

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
      });

      attachDisconnectHandler(connection, guildId, guild);
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      ensureStream();
      log.info(`[${guild.name}] Auto-rejoined #${channel.name} after restart.`);
    } catch (err) {
      log.warn(`[${guildId}] Auto-rejoin failed: ${err.message}`);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, guild, member } = interaction;
  log.info(`[${guild?.name ?? guildId}] @${interaction.user.tag} used /${commandName}`);

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
});

// Start/stop the shared stream based on whether real users are in the bot's
// voice channel. The bot stays connected 24/7 but only consumes the radio
// stream while someone is actually listening.
client.on('voiceStateUpdate', (oldState, newState) => {
  const guildId = (newState.guild ?? oldState.guild)?.id;
  if (!guildId || !guildState.has(guildId)) return;
  if (newState.member?.user?.bot) return; // ignore bot (incl. our own) voice changes

  const botChannelId = guildState.get(guildId).voiceChannelId;
  // Only react when the change involves the bot's channel (someone joined or left it).
  if (oldState.channelId !== botChannelId && newState.channelId !== botChannelId) return;

  ensureStream();
});

client.login(process.env.BOT_TOKEN);
