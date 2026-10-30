// Minimal, dependency-free .xlsx reader: enough to read a table of numbers and text from a sheet.
// An .xlsx file is a zip of XML parts. Formulas are read as their cached (last calculated) value.
const fs = require('fs');
const zlib = require('zlib');

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not an .xlsx file (no zip directory found)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files.set(name, () => (method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : (() => { throw new Error(`unsupported zip method ${method}`); })()).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? unescape(m[1]) : null; };
const texts = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join('');

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

// Returns [{ name, rows }] where rows[r][c] is a number, string or null.
function readWorkbook(file) {
  const files = unzip(fs.readFileSync(file));
  const get = (n) => { const f = files.get(n); if (!f) throw new Error(`missing ${n} in workbook`); return f(); };
  const shared = files.has('xl/sharedStrings.xml')
    ? [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1])) : [];
  const rels = new Map([...get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)]
    .map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const sheets = [];
  for (const m of get('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const target = rels.get(attr(m[0], 'r:id'));
    const xml = get(target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    const rows = [];
    for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c${cm[1]}>`;
        const body = cm[2] || '';
        const ref = attr(tag, 'r');
        const type = attr(tag, 't');
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let value = null;
        if (type === 's') value = shared[Number(v)];
        else if (type === 'inlineStr') value = texts(body);
        else if (type === 'str' || type === 'e') value = v == null ? null : unescape(v);
        else if (type === 'b') value = v === '1';
        else if (v != null) value = Number(v);
        const r = Number(ref.match(/\d+$/)[0]) - 1;
        (rows[r] = rows[r] || [])[colIndex(ref)] = value;
      }
    }
    sheets.push({ name: attr(m[0], 'name'), rows: Array.from(rows, (r) => r || []) });
  }
  return sheets;
}

module.exports = { readWorkbook };
