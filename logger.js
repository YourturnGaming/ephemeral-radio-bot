const fs = require('fs');
const path = require('path');

const LOG_DIR  = path.join(__dirname, 'logs');
const CURRENT  = path.join(LOG_DIR, 'bot.log');
const PREVIOUS = path.join(LOG_DIR, 'bot-old.log');

// ── Setup: rotate on startup ───────────────────────────────────────────────

fs.mkdirSync(LOG_DIR, { recursive: true });

// Remove any stale files that are neither current nor previous
for (const file of fs.readdirSync(LOG_DIR)) {
  const full = path.join(LOG_DIR, file);
  if (full !== CURRENT && full !== PREVIOUS) {
    try { fs.unlinkSync(full); } catch {}
  }
}

// Rotate: current → previous
if (fs.existsSync(CURRENT)) {
  try {
    if (fs.existsSync(PREVIOUS)) fs.unlinkSync(PREVIOUS);
    fs.renameSync(CURRENT, PREVIOUS);
  } catch {}
}

// Create fresh log file for this session
const stream = fs.createWriteStream(CURRENT, { flags: 'a' });

// ── Logger ─────────────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function write(level, message) {
  const line = `[${timestamp()}] [${level}] ${message}`;
  console.log(line);
  stream.write(line + '\n');
}

const logger = {
  info:  (msg) => write('INFO ', msg),
  warn:  (msg) => write('WARN ', msg),
  error: (msg) => write('ERROR', msg),
};

module.exports = logger;
