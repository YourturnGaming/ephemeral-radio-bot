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
- 🚚 `/move` — admins can send the bot to another voice channel, or call it to theirs, without interrupting playback
- 📊 Optional listener stats — tracks how long each user actually listens, with `/listentime` and `/toplisteners`
- 👍 👎 ⭐ Like, dislike and favourite buttons on every now-playing message, keyed to a stable track ID
- `/play` `/stop` `/move` `/nowplaying` `/like` `/dislike` `/favourite` `/favourites` `/toptracks` `/listentime` `/toplisteners` `/announce` `/songs` `/setrole` `/subscribe` `/optout` `/forgetme` `/help` slash commands

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
| `/move` | Server | Move the bot to another voice channel. Leave the `channel` option blank to bring it to yours. Requires **Move Members** (or **Manage Server**) and the bot to be streaming. |
| `/nowplaying` | Server | Show the currently playing track and listener count |
| `/announce` | Server | Toggle live DJ announcements in the current channel (goes live / set ends). Run again to turn off, or run in a different channel to move it there. Requires the bot to be streaming. |
| `/songs` | Server | Toggle song change announcements in the current channel. No role ping. Run again to turn off, or run in a different channel to move it there. Requires the bot to be streaming. |
| `/setrole` | Server | Set a role to ping on live DJ announcements. Leave the role option blank to clear it. Requires **Manage Server** permission. |
| `/like` `/dislike` | Server | Rate the track currently playing. Running the same one again clears your rating. |
| `/favourite` | Server | Save the current track to your favourites. Run again to remove it. |
| `/favourites` | Server or DM | List your 25 most recently favourited tracks |
| `/toptracks` | Server | The ten highest rated tracks, ranked by likes minus dislikes |
| `/listentime` | Server | Show how long you — or another user — have listened. Requires stats to be enabled. |
| `/toplisteners` | Server | Leaderboard of the ten longest-listening users. Opted-out users are excluded. |
| `/optout` | Server or DM | Toggle whether your listening time is recorded. Existing data is kept. |
| `/forgetme` | Server or DM | Delete all listening data stored about you |
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
- Alerts fire when a set **starts** and again when it **ends**, so you're never left with a "now live" DM for a set that finished hours ago
- Live state survives restarts. Restarting the bot mid-set won't re-announce it, and if a set ended while the bot was down, the end alert goes out on the next poll instead of being lost

---

## Listener stats and ratings

Optional. With `DB_HOST` unset the bot behaves exactly as it always has, and the stats and rating commands report as unavailable — upgrading breaks nothing.

### Listening time

The bot records how long each user spends listening. A session counts only while **all three** hold: the stream is actually playing, the user is in the bot's voice channel, and they are not deafened. Without the deafen check this would measure "sat in a channel" rather than "listened".

Sessions are heartbeated once a minute, so an unclean shutdown loses at most a minute. On the next boot any session left open is closed at its last heartbeat rather than at the current time — otherwise the bot's entire downtime would be credited as listening time.

### Ratings

Every now-playing announcement carries 👍 👎 ⭐ buttons, and `/like`, `/dislike` and `/favourite` do the same for whatever is on air. Pressing the same button again clears it, so a misclick is one click to undo.

Ratings key off `song.id` from the station's nowplaying API — a stable hash — not the ICY stream title. The ICY title is a display string; keying off it would orphan every existing rating the first time a track was re-tagged or its punctuation changed.

Buttons carry the ID of the song the message was posted for, not "whatever is playing now". A message sits in a channel long after the track has moved on, and a late click rates the song it was posted for.

Favourites are stored separately from likes rather than as a third rating value. A favourite is a bookmark, not a stronger like, and collapsing them makes "show me my favourites" and "what's popular" compete for the same column.

### Option 1 — bundled MariaDB

Uncomment `COMPOSE_PROFILES=local-db` in `.env`, set `DB_PASSWORD` and `DB_ROOT_PASSWORD`, then:

```bash
docker compose up -d
```

That starts MariaDB alongside the bot on a private network. The container publishes no ports — nothing outside the compose stack can reach it.

### Option 2 — your own database server

Leave `COMPOSE_PROFILES` unset so the bundled container never starts, point `DB_HOST` at your server, and set `DB_SSL=true`. Then create the database and a user for the bot:

```sql
CREATE DATABASE ephemeral_bot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'ephemeral_bot'@'%' IDENTIFIED BY 'your_password' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX ON ephemeral_bot.* TO 'ephemeral_bot'@'%';
```

`CREATE` and `INDEX` are needed because the bot applies its own schema on boot — it creates tables only if they don't already exist, and records the applied version in a `schema_version` table so later upgrades migrate cleanly. Scope those grants to the bot's own database, never globally.

Use `utf8mb4`. MariaDB's `utf8` is three-byte and will mangle or reject four-byte characters, which track and artist names hit sooner than you'd expect.

### Reading the data from a website

The schema is meant to be queried directly. Create a **separate, read-only** user for anything that reads it:

```sql
CREATE USER 'ephemeral_web'@'%' IDENTIFIED BY 'another_password' REQUIRE SSL;
GRANT SELECT ON ephemeral_bot.* TO 'ephemeral_web'@'%';
```

That one grant is what stands between a bug in a website and the bot's data.

### Privacy

Listening time is recorded by default and `/toplisteners` is public. Users control their own data:

- `/optout` stops recording listening time and ratings, and hides them from the leaderboard. Existing rows are kept.
- `/forgetme` deletes every row about them — sessions, ratings and favourites — immediately and for real.

Note what is *not* stored: no message content, no per-user play history, and no record of which channel someone was in beyond the session row itself.

A database outage never affects playback. Every stats write is best-effort — a dead database costs you rows, not the stream.

---

## Persistent Settings

The bot saves its settings to the `data/` directory and restores them automatically on restart:

| Setting | Stored in | Set by | Cleared by |
|---|---|---|---|
| Voice channel to stream in | `guilds.json` | `/play`, `/move` | `/stop` |
| Live DJ announcement channel | `guilds.json` | `/announce` | `/announce` (toggle off) |
| Song announcement channel | `guilds.json` | `/songs` | `/songs` (toggle off) |
| Ping role (live DJ only) | `guilds.json` | `/setrole @role` | `/setrole` (no role selected) |
| DM alert subscribers | `subscribers.json` | `/subscribe` | `/subscribe` (toggle off) |
| Live DJ state (who's on air) | `live.json` | the metadata poll | the metadata poll |

The bot will **automatically rejoin** its voice channel after a restart — no need to run `/play` again.

---

## How streaming works

- **One shared stream.** No matter how many servers the bot streams to, it opens a single connection to the radio source and fans that one audio feed out to every voice channel. So on the website's listener count the bot only ever shows as **1** listener while playing (plus 1 for the always-on title watcher), not one per server.
- **Listener-aware.** The bot stays parked in its voice channel 24/7, but it only runs the stream while a real (non-bot) user is in the channel with it. When everyone leaves, it goes silent and drops the radio connection; when someone joins, it starts back up automatically.
- **Outage-aware.** If the radio source becomes unreachable (e.g. your internet drops), the bot detects it via the metadata API and *stops* trying to reconnect the audio stream — instead of hammering the server with a new connection every couple of seconds. It reconnects automatically, with exponential backoff, once connectivity returns. This prevents the listener count from being inflated by stale/half-open connections during an outage.
- **Follows moves.** Admins can drag the bot between voice channels without interrupting playback — it adopts the new channel and keeps streaming. `/move` does the same thing by command, for when dragging isn't practical (mobile, or a channel you can't see). Either way the connection is reused rather than rebuilt, so the audio doesn't cut.
- **Voice recovery.** When connectivity returns, the bot rebuilds its Discord voice connections. A network drop can leave a voice connection as a stale "zombie" (still marked ready, but audio goes nowhere) without ever firing a disconnect event, so the bot proactively re-establishes them rather than waiting for an event that never comes.

---

## Environment Variables

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Your Discord bot token |
| `DB_HOST` | Database hostname. **Leave blank to disable stats entirely** — the bot runs exactly as it did without them. |
| `DB_PORT` | Database port (default `3306`) |
| `DB_NAME` | Database name (default `ephemeral_bot`) |
| `DB_USER` / `DB_PASSWORD` | Credentials for the bot's database user |
| `DB_ROOT_PASSWORD` | Root password for the **bundled** MariaDB container only. Ignored with an external database. |
| `DB_SSL` | Set `true` to use TLS. Leave unset for the bundled container — that traffic never leaves the private Docker network. |
| `DB_SSL_CA` | Path to a CA certificate, for a database using a self-signed cert |
| `DB_SSL_REJECT_UNAUTHORIZED` | Set `false` to skip certificate verification. Encrypts but does **not** authenticate — prefer `DB_SSL_CA`. |
| `COMPOSE_PROFILES` | Set to `local-db` to run the bundled MariaDB container. Leave unset when using your own database server. |

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
