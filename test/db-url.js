// The tests wipe and re-create their database, so they run only against a Supabase project kept for
// testing (TEST_DATABASE_URL, from the environment or .env), never the game's DATABASE_URL.
const { readEnvFile } = require('../src/env');

const file = readEnvFile();
const url = process.env.TEST_DATABASE_URL || file.TEST_DATABASE_URL;
const game = process.env.DATABASE_URL || file.DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to a separate Supabase project for tests (the tests wipe it). See docs/SUPABASE.md');
if (url === game) throw new Error('TEST_DATABASE_URL is the game database (DATABASE_URL); the tests would wipe the game. Use a separate Supabase project.');
process.env.DATABASE_URL = url;
