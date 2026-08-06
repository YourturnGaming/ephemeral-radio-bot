// MariaDB/MySQL access layer.
//
// Two rules govern everything in here:
//
//  1. Stats are OPTIONAL. If DB_HOST is unset the whole subsystem stays dormant
//     and the bot behaves exactly as it did before stats existed — existing
//     deployments must not break by upgrading.
//  2. Stats are LOSSY. A database outage must never stop the audio. Every call
//     returns null instead of throwing, so a dead database costs you rows, not
//     the stream. Callers treat null as "not recorded" and move on.

const mysql = require('mysql2/promise');
const fs = require('fs');
const log = require('./logger');

let pool = null;
let ready = false;       // schema applied, safe to read/write
let lastErrorLogged = ''; // de-dupes the same connection error every heartbeat

const enabled = !!process.env.DB_HOST;

// TLS for the connection to an external database. Off by default, because the
// bundled compose stack talks to MariaDB over a private Docker network where
// there's nothing to intercept.
function sslOptions() {
  const mode = (process.env.DB_SSL ?? '').toLowerCase();
  if (mode !== 'true' && mode !== '1') return undefined;

  // A self-hosted MariaDB usually presents a self-signed cert, which fails
  // default verification. Point DB_SSL_CA at its CA file to verify it properly.
  let ca;
  if (process.env.DB_SSL_CA) {
    try {
      ca = fs.readFileSync(process.env.DB_SSL_CA);
    } catch (err) {
      log.error(`Could not read DB_SSL_CA (${process.env.DB_SSL_CA}): ${err.message}`);
    }
  }

  // Setting this false still encrypts the connection but stops verifying who's
  // on the other end — it will not detect an interception. Prefer DB_SSL_CA.
  const rejectUnauthorized = (process.env.DB_SSL_REJECT_UNAUTHORIZED ?? 'true').toLowerCase() !== 'false';
  if (!rejectUnauthorized) {
    log.warn('DB_SSL_REJECT_UNAUTHORIZED=false — the database connection is encrypted but unauthenticated.');
  }

  return { ca, rejectUnauthorized, minVersion: 'TLSv1.2' };
}

// Schema migrations, applied in order. Each entry runs once; the highest applied
// version is recorded in schema_version. Adding a migration later means
// appending to this array — never editing an existing entry, or deployments that
// already ran it will silently diverge.
const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
         discord_id  VARCHAR(20)  NOT NULL PRIMARY KEY,
         first_seen  DATETIME(3)  NOT NULL,
         last_seen   DATETIME(3)  NOT NULL,
         opted_out   TINYINT(1)   NOT NULL DEFAULT 0
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS tracks (
         song_id     CHAR(32)      NOT NULL PRIMARY KEY,
         artist      VARCHAR(512)  NOT NULL DEFAULT '',
         title       VARCHAR(512)  NOT NULL DEFAULT '',
         album       VARCHAR(512)  NOT NULL DEFAULT '',
         genre       VARCHAR(128)  NOT NULL DEFAULT '',
         art_url     VARCHAR(1024) NOT NULL DEFAULT '',
         first_seen  DATETIME(3)   NOT NULL,
         play_count  INT UNSIGNED  NOT NULL DEFAULT 0
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS sessions (
         id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         discord_id    VARCHAR(20)  NOT NULL,
         guild_id      VARCHAR(20)  NOT NULL,
         channel_id    VARCHAR(20)  NOT NULL,
         started_at    DATETIME(3)  NOT NULL,
         last_seen_at  DATETIME(3)  NOT NULL,
         ended_at      DATETIME(3)  NULL,
         seconds       INT UNSIGNED NOT NULL DEFAULT 0,
         INDEX ix_sessions_user (discord_id),
         INDEX ix_sessions_open (ended_at),
         INDEX ix_sessions_guild (guild_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    version: 2,
    statements: [
      // Ratings and favourites are separate tables on purpose. A favourite is a
      // bookmark, not a stronger like — collapsing them into one column makes
      // "show me my favourites" and "what's popular" fight over the same field.
      `CREATE TABLE IF NOT EXISTS ratings (
         discord_id  VARCHAR(20) NOT NULL,
         song_id     CHAR(32)    NOT NULL,
         value       TINYINT     NOT NULL,   -- +1 like, -1 dislike
         rated_at    DATETIME(3) NOT NULL,
         PRIMARY KEY (discord_id, song_id),
         INDEX ix_ratings_song (song_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      `CREATE TABLE IF NOT EXISTS favourites (
         discord_id  VARCHAR(20) NOT NULL,
         song_id     CHAR(32)    NOT NULL,
         added_at    DATETIME(3) NOT NULL,
         PRIMARY KEY (discord_id, song_id),
         INDEX ix_favourites_song (song_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      // One row per airing. tracks.play_count alone can only ever answer
      // "all time"; this is what makes "this week" or "what was on at 9pm"
      // possible for a website later.
      `CREATE TABLE IF NOT EXISTS plays (
         id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         song_id        CHAR(32)     NOT NULL,
         started_at     DATETIME(3)  NOT NULL,
         is_live        TINYINT(1)   NOT NULL DEFAULT 0,
         streamer_name  VARCHAR(255) NOT NULL DEFAULT '',
         INDEX ix_plays_song (song_id),
         INDEX ix_plays_time (started_at)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
];

async function applyMigrations() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_version (
       id           TINYINT     NOT NULL PRIMARY KEY,
       version      INT         NOT NULL,
       applied_at   DATETIME(3) NOT NULL
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  const [rows] = await pool.query('SELECT version FROM schema_version WHERE id = 1');
  const current = rows[0]?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    for (const statement of migration.statements) {
      await pool.query(statement);
    }
    await pool.query(
      `INSERT INTO schema_version (id, version, applied_at) VALUES (1, ?, NOW(3))
       ON DUPLICATE KEY UPDATE version = VALUES(version), applied_at = VALUES(applied_at)`,
      [migration.version]
    );
    log.info(`Applied database migration v${migration.version}.`);
  }

  if (current >= MIGRATIONS[MIGRATIONS.length - 1].version) {
    log.info(`Database schema up to date (v${current}).`);
  }
}

// Connects and migrates. Retries with backoff rather than giving up, so a bot
// that boots before its database is reachable heals itself instead of needing a
// restart. Never throws — the bot streams regardless.
async function init() {
  if (!enabled) {
    log.info('DB_HOST not set — listener stats disabled.');
    return false;
  }

  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: sslOptions(),
    connectionLimit: 5,
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    timezone: 'Z',            // store and read UTC; never depend on server tz
    supportBigNumbers: true,
    bigNumberStrings: true,   // BIGINT ids as strings — JS numbers lose precision
    charset: 'utf8mb4_unicode_ci',
  });

  let delay = 5_000;
  for (;;) {
    try {
      await applyMigrations();
      ready = true;
      lastErrorLogged = '';
      log.info(`Connected to database ${process.env.DB_NAME} at ${process.env.DB_HOST}.`);
      return true;
    } catch (err) {
      log.warn(`Database init failed (${err.message}) — retrying in ${delay / 1000}s.`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

// The only way anything in this module talks to the database. Returns null on
// any failure, having logged it once — callers branch on null, never catch.
async function query(sql, params = []) {
  if (!enabled || !ready) return null;
  try {
    const [rows] = await pool.query(sql, params);
    if (lastErrorLogged) {
      log.info('Database reachable again.');
      lastErrorLogged = '';
    }
    return rows;
  } catch (err) {
    if (lastErrorLogged !== err.message) {
      log.warn(`Database query failed: ${err.message}`);
      lastErrorLogged = err.message;
    }
    return null;
  }
}

async function close() {
  if (pool) {
    try { await pool.end(); } catch {}
    pool = null;
    ready = false;
  }
}

module.exports = {
  get enabled() { return enabled; },
  get ready() { return ready; },
  init,
  query,
  close,
};
