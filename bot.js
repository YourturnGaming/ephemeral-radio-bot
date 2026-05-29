const {
  Client,
  GatewayIntentBits,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
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
require('dotenv').config();

// Use system ffmpeg if available, fall back to ffmpeg-static
let ffmpegBin = 'ffmpeg';
try {
  const { execSync } = require('child_process');
  execSync('ffmpeg -version', { stdio: 'ignore' });
} catch {
  ffmpegBin = require('ffmpeg-static');
}

const STREAM_URL = 'https://listen.ephemeral.club/listen/ephemeral/radio.mp3';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Per-guild state
const guildState = new Map();

// ── ICY metadata watcher ───────────────────────────────────────────────────

let currentTitle = 'Ephemeral FM';

function parseIcyTitle(metaStr) {
  const match = metaStr.match(/StreamTitle='([^']*)'/);
  return match ? match[1].trim() : null;
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
            if (bytesUntilMeta === 0) {
              readingMeta = true;
              metaLen = 0;
              metaBuf = Buffer.alloc(0);
            }
          } else if (metaLen === 0) {
            metaLen = chunk[pos++] * 16;
            if (metaLen === 0) {
              readingMeta = false;
              bytesUntilMeta = metaint;
            }
          } else {
            const needed = metaLen - metaBuf.length;
            const take = Math.min(needed, chunk.length - pos);
            metaBuf = Buffer.concat([metaBuf, chunk.subarray(pos, pos + take)]);
            pos += take;
            if (metaBuf.length >= metaLen) {
              const title = parseIcyTitle(metaBuf.toString('utf8'));
              if (title && title !== currentTitle) {
                currentTitle = title;
                console.log(`Now playing: ${title}`);
                client.user?.setActivity(title, { type: ActivityType.Listening });
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
    '-i', STREAM_URL,
    '-vn',
    '-ar', '48000',
    '-ac', '2',
    '-f', 's16le',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  return createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
}

function startStream(guildId) {
  const state = guildState.get(guildId);
  if (!state) return;
  const resource = createStream();
  state.player.play(resource);
  state.resource = resource;
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
].map((c) => c.toJSON());

// ── Bot events ─────────────────────────────────────────────────────────────

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }

  watchIcyMetadata();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, guild, member } = interaction;

  // ── /play ──────────────────────────────────────────────────────────────
  if (commandName === 'play') {
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: 'You need to be in a voice channel first.', ephemeral: true });
    }

    await interaction.deferReply();

    if (guildState.has(guildId)) {
      guildState.get(guildId).connection.destroy();
      guildState.delete(guildId);
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    const player = createAudioPlayer();
    connection.subscribe(player);
    guildState.set(guildId, { connection, player, resource: null });

    player.on(AudioPlayerStatus.Idle, () => setTimeout(() => startStream(guildId), 2_000));
    player.on('error', (err) => {
      console.error(`Player error in guild ${guildId}:`, err.message);
      setTimeout(() => startStream(guildId), 5_000);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        connection.destroy();
        guildState.delete(guildId);
      }
    });

    startStream(guildId);

    await interaction.editReply(
      `Now streaming **Ephemeral FM** in **${voiceChannel.name}**\n🎵 ${currentTitle}`
    );
  }

  // ── /stop ──────────────────────────────────────────────────────────────
  if (commandName === 'stop') {
    if (!guildState.has(guildId)) {
      return interaction.reply({ content: 'Not currently streaming.', ephemeral: true });
    }
    guildState.get(guildId).connection.destroy();
    guildState.delete(guildId);
    await interaction.reply('Stopped streaming and left the voice channel.');
  }

  // ── /nowplaying ────────────────────────────────────────────────────────
  if (commandName === 'nowplaying') {
    await interaction.reply(`🎵 ${currentTitle}`);
  }
});

client.login(process.env.BOT_TOKEN);
