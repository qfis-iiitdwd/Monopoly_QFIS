// The game config used by the tests. config/game.json is the secret event config and is not in
// git; a fresh clone falls back to test/fixtures/game.json (same companies, made-up price script).
const fs = require('fs');
const path = require('path');

const real = path.join(__dirname, '..', 'config', 'game.json');
const REAL_CONFIG = fs.existsSync(real);
const baseConfig = JSON.parse(fs.readFileSync(REAL_CONFIG ? real : path.join(__dirname, 'fixtures', 'game.json'), 'utf8'));
// The tests use their own 50 teams (team01 / pw-team01 ...), not the event's real roster and passwords.
baseConfig.teams = { count: 50, name_prefix: 'Team', id_prefix: 'team' };

module.exports = { baseConfig, REAL_CONFIG };
