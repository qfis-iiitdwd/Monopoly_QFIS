const fs = require('fs');
const path = require('path');

// Variables in .env at the repo root (DATABASE_URL, ...), as { name: value }.
function readEnvFile(file = path.join(__dirname, '..', '.env')) {
  const vars = {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return vars; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

// Copies .env into process.env, so `npm start`, the seed and preflight work on a laptop without
// exporting anything. Never overrides a variable that is already set: tests and containers keep their own.
function loadEnvFile(file) {
  for (const [k, v] of Object.entries(readEnvFile(file))) if (!(k in process.env)) process.env[k] = v;
}

module.exports = { readEnvFile, loadEnvFile };
