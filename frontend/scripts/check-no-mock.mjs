// Build gate: the UI may only show what the API returns. Fails the build if mock data,
// alert() stubs, random numbers or the old sample tickers/teams creep back into the source.
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const BANNED = [
  [/mockData|adminMockData|INITIAL_[A-Z]+|ADMIN_(TEAMS|ORDERS|TRANSACTIONS|ACTIVITIES|ROUNDS|PRICE_UPDATES|STATS)/, 'mock data'],
  [/\balert\(/, 'alert() stub'],
  [/Math\.random/, 'random numbers'],
  [/['"`](ALP|BVG|CRL|DYN|EKO)['"`]/, 'sample tickers'],
  [/Team (07|12|03|21)\b/, 'sample team names'],
];
const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|jsx?)$/.test(f)) files.push(p);
  }
})(new URL('../src', import.meta.url).pathname);
const problems = [];
for (const f of files) {
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    for (const [re, what] of BANNED) if (re.test(line)) problems.push(`${f}:${i + 1}: ${what}: ${line.trim()}`);
  });
}
if (problems.length) {
  console.error('check-no-mock failed:\n' + problems.join('\n'));
  process.exit(1);
}
console.log(`check-no-mock: ${files.length} files clean`);
