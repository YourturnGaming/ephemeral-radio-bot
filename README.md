# Ephemeral Radio Bot

A Discord bot that streams [Ephemeral FM](https://ephemeral.club) into your voice channels. Track info is pulled live from the stream's ICY metadata and shown as the bot's status.

## Features

- 🎵 Streams Ephemeral FM into any voice channel
- 📻 Bot status updates in real-time when the track changes (via ICY stream metadata)
- 🔔 Optional per-channel announcements when the track changes
- 🔁 Auto-reconnects if the stream drops
- `/play` `/stop` `/nowplaying` `/announce` slash commands

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

#### Fixing the startup command (optional but recommended)

The default egg startup command has a bug where `.js` files are always run through `ts-node` instead of `node`. To fix it, go to **Admin → Nests → Node.js Generic → Edit Egg** and replace the startup command with:

```
if [[ -d .git ]] && [[ {{AUTO_UPDATE}} == "1" ]]; then git pull; fi; if [[ ! -z ${NODE_PACKAGES} ]]; then /usr/local/bin/npm install ${NODE_PACKAGES}; fi; if [[ ! -z ${UNNODE_PACKAGES} ]]; then /usr/local/bin/npm uninstall ${UNNODE_PACKAGES}; fi; if [ -f /home/container/package.json ]; then /usr/local/bin/npm install; fi; if [[ "${MAIN_FILE}" == *.js ]]; then /usr/local/bin/node "/home/container/${MAIN_FILE}" ${NODE_ARGS}; else /usr/local/bin/ts-node --esm "/home/container/${MAIN_FILE}" ${NODE_ARGS}; fi
```

---

## Commands

| Command | Description |
|---|---|
| `/play` | Join your voice channel and start streaming |
| `/stop` | Stop streaming and leave the voice channel |
| `/nowplaying` | Show the currently playing track |
| `/announce` | Toggle now-playing announcements in the current channel. Run again to turn off, or run in a different channel to move it there. Requires the bot to be streaming. |

---

## Environment Variables

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Your Discord bot token |
