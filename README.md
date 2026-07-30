# Ephemeral Radio Bot

A Discord bot that streams [Ephemeral FM](https://ephemeral.club) into your voice channels. Track info is pulled live from the stream's ICY metadata and shown as the bot's status.

## Features

- 🎵 Streams Ephemeral FM into any voice channel
- 📻 Bot status updates in real-time when the track changes (via ICY stream metadata)
- 👥 Live listener count shown in bot status, `/play`, and `/nowplaying`
- 🎙️ Live DJ detection — announces when a DJ goes live or ends their set
- 🔔 Optional per-channel announcements for song changes and live DJ events
- 📬 Personal DM alerts when a DJ goes live — users opt in themselves with `/subscribe`
- 🔁 Auto-reconnects if the stream drops or the bot is kicked
- 💾 Remembers your settings (announce channel, ping role, voice channel, subscribers) across restarts
- 🪶 Single shared stream — one connection to the radio source no matter how many servers it streams to
- 💤 Only streams when someone's listening — stays parked in the channel 24/7 but goes silent (and drops the radio connection) when the channel is empty
- `/play` `/stop` `/nowplaying` `/announce` `/songs` `/setrole` `/subscribe` `/help` slash commands

---

## Setup

### 1. Create a Discord Bot

1. Go to [discord.com/developers](https://discord.com/developers/applications) and create a new application
2. Go to the **Bot** tab and copy your token
3. Under **Privileged Gateway Intents**, enable **Server Members Intent**
4. Go to **OAuth2 → URL Generator**, select scopes: `bot` + `applications.commands`
5. Under Bot Permissions select:
   - **General:** View Channels
   - **Text:** Send Messages, Read Message History, Embed Links
   - **Voice:** Connect, Speak, Priority Speaker, Set Voice Channel Status
6. Use the generated URL to invite the bot to your server

---

## Deployment

### Option 1 — Docker Compose (Recommended)

**Requirements:** Docker

```bash
git clone https://github.com/YourturnGaming/ephemeral-radio-bot.git
cd ephemeral-radio-bot
cp .env.example .env
```

Edit `.env` and add your bot token:
```
BOT_TOKEN=your_token_here
```

Start the bot:
```bash
docker compose up -d
```

View logs:
```bash
docker compose logs -f
```

Stop the bot:
```bash
docker compose down
```

> Settings are stored in `./data/` (`guilds.json` and `subscribers.json`), which is mounted as a volume so they survive container rebuilds and recreations.

---

### Option 2 — Node.js (Local)

**Requirements:** Node.js 22+, ffmpeg installed and in PATH

```bash
git clone https://github.com/YourturnGaming/ephemeral-radio-bot.git
cd ephemeral-radio-bot
npm install
cp .env.example .env
```

Edit `.env` and add your bot token, then:
```bash
node bot.js
```

---

### Option 3 — Pelican Panel

**Requirements:** Pelican Panel with the [Node.js Generic egg](https://pelican-eggs.github.io/pelican/)

1. In your Pelican Panel, create a new server using the **Node.js Generic** egg
2. Set the following in the **Startup** tab:
   | Variable | Value |
   |---|---|
   | Git Repo Address | `https://github.com/YourturnGaming/ephemeral-radio-bot.git` |
   | Main file | `bot.js` |
   | Auto Update | `1` |
   | User Uploaded Files | Enabled |

3. Start the server once to let it create the `/home/container` directory
4. Go to the **Files** tab and create a `.env` file at `/home/container/.env`:
   ```
   BOT_TOKEN=your_token_here
   ```
5. Restart the server — the bot will install its dependencies and start automatically

> **Note:** ffmpeg is not available in the Pelican Node.js egg image. The bot will automatically fall back to the bundled `ffmpeg-static` binary.

#### Fixing the "Starting" status

By default Pelican will show the server as **Starting** forever because the egg doesn't know when the bot is ready. To fix this:

1. Go to **Admin → Nests → Node.js Generic → Edit Egg**
2. Open the **Process Management** tab
3. Set **Start Completed Log Detection** to:
   ```
   Ephemeral Bot is Ready!
   ```
4. Save the egg and restart your server — Pelican will now flip to **Running** as soon as the bot logs in

---

## Commands

| Command | Where | Description |
|---|---|---|
| `/play` | Server | Join your voice channel and start streaming. Shows current track and listener count. |
| `/stop` | Server | Stop streaming and leave the voice channel |
| `/nowplaying` | Server | Show the currently playing track and listener count |
| `/announce` | Server | Toggle live DJ announcements in the current channel (goes live / set ends). Run again to turn off, or run in a different channel to move it there. Requires the bot to be streaming. |
| `/songs` | Server | Toggle song change announcements in the current channel. No role ping. Run again to turn off, or run in a different channel to move it there. Requires the bot to be streaming. |
| `/setrole` | Server | Set a role to ping on live DJ announcements. Leave the role option blank to clear it. Requires **Manage Server** permission. |
| `/subscribe` | Server or DM | Toggle personal DM alerts for when a DJ goes live |
| `/help` | Server or DM | List every command, with links to the site and this repo |

Commands that need a server (voice channels, per-channel settings) are restricted to the **Guild** context, so they don't clutter the bot's command list in DMs. Only `/subscribe` and `/help` are available in DMs.

---

## Live DJ DM alerts

Any user can opt in to a DM whenever a DJ goes live — no admin setup required:

1. Run `/subscribe` (in any server with the bot, or in a DM with it)
2. The bot sends a confirmation DM with **Keep alerts** / **Unsubscribe** buttons, so it's one click to back out
3. From then on, each time a DJ goes live you get a DM with a link straight to the site

Notes:

- Subscriptions are **per user, not per server** — you get one DM per live set even if you share several servers with the bot
- If your DMs are closed, `/subscribe` tells you instead of silently failing, and users who later close their DMs are pruned from the list automatically
- Run `/subscribe` again (or hit the button) any time to stop
- Alerts fire when a set **starts**. Channel announcements via `/announce` also cover set endings.

---

## Persistent Settings

The bot saves its settings to the `data/` directory and restores them automatically on restart:

| Setting | Stored in | Set by | Cleared by |
|---|---|---|---|
| Voice channel to stream in | `guilds.json` | `/play` | `/stop` |
| Live DJ announcement channel | `guilds.json` | `/announce` | `/announce` (toggle off) |
| Song announcement channel | `guilds.json` | `/songs` | `/songs` (toggle off) |
| Ping role (live DJ only) | `guilds.json` | `/setrole @role` | `/setrole` (no role selected) |
| DM alert subscribers | `subscribers.json` | `/subscribe` | `/subscribe` (toggle off) |

The bot will **automatically rejoin** its voice channel after a restart — no need to run `/play` again.

---

## How streaming works

- **One shared stream.** No matter how many servers the bot streams to, it opens a single connection to the radio source and fans that one audio feed out to every voice channel. So on the website's listener count the bot only ever shows as **1** listener while playing (plus 1 for the always-on title watcher), not one per server.
- **Listener-aware.** The bot stays parked in its voice channel 24/7, but it only runs the stream while a real (non-bot) user is in the channel with it. When everyone leaves, it goes silent and drops the radio connection; when someone joins, it starts back up automatically.
- **Outage-aware.** If the radio source becomes unreachable (e.g. your internet drops), the bot detects it via the metadata API and *stops* trying to reconnect the audio stream — instead of hammering the server with a new connection every couple of seconds. It reconnects automatically, with exponential backoff, once connectivity returns. This prevents the listener count from being inflated by stale/half-open connections during an outage.
- **Follows moves.** Admins can drag the bot between voice channels without interrupting playback — it adopts the new channel and keeps streaming.
- **Voice recovery.** When connectivity returns, the bot rebuilds its Discord voice connections. A network drop can leave a voice connection as a stale "zombie" (still marked ready, but audio goes nowhere) without ever firing a disconnect event, so the bot proactively re-establishes them rather than waiting for an event that never comes.

---

## Environment Variables

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Your Discord bot token |

---

## AI disclaimer

This project was built with substantial help from AI. The majority of the code in this repository was written by [Claude Code](https://claude.com/claude-code) (Anthropic) working from my prompts, direction, and testing.

What that means in practice:

- Every feature was specified, reviewed, and tested by a human before being merged
- Behaviour was verified against a real Discord bot in a Docker container, not just assumed to work from the code
- Bugs found in testing were fed back and fixed, rather than shipped

It's still worth reading the code yourself before running it — treat it like any other unfamiliar open-source project. If you spot something wrong, please open an issue.

---

## Disclaimer

This is an unofficial, fan-made project. It is not affiliated with, endorsed by, or operated by Ephemeral FM. It simply plays their public stream and reads their public metadata API.

If you enjoy the station, please listen at [ephemeral.club](https://ephemeral.club) directly — it sounds better than Discord's compressed audio, and it means the station gets an accurate listener count.
