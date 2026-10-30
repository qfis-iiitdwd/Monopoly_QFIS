// The game config used by the tests. config/game.json is the secret event config and is not in
// git; a fresh clone falls back to test/fixtures/game.json (same companies, made-up price script).
const fs = require('fs');
const path = require('path');

const real = path.join(__dirname, '..', 'config', 'game.json');
const REAL_CONFIG = fs.existsSync(real);
const baseConfig = JSON.parse(fs.readFileSync(REAL_CONFIG ? real : path.join(__dirname, 'fixtures', 'game.json'), 'utf8'));

module.exports = { baseConfig, REAL_CONFIG };
