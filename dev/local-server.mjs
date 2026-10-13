// Local stand-in for the Apps Script backend. It runs appscript.gs itself in
// Node, over in-memory Sheets / cache / Script Properties, and serves the site
// next to it — so the panel and the player can be tried end to end without
// touching the live screen, its sheet or its devices.
//
//   node dev/local-server.mjs      → http://127.0.0.1:8124/  (player.html too)
//
// • config.js is served with SCRIPT_URL pointing here.
// • The old shared code is LEGACY_TEST below, not the real one.
// • Emailed pairing codes are printed here and listed at /dev/outbox.
// • /dev/state shows the devices and the playlist.
// • KIOSK_GS=<file> runs another version of the backend, e.g. the one still
//   deployed (`git show <commit>:appscript.gs`), to try a new frontend on it.
// Nothing in dev/ is deployed: .claspignore pushes only appscript.gs, and
// _config.yml keeps dev/ off the Pages site.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LEGACY_TEST = 'legacy-test-code-0123456789';

const sha256 = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// ── Google services, just as much of them as appscript.gs uses ──

// What Sheets does with a typed value: a leading apostrophe forces text and is
// not part of the value; numbers become numbers; = + - @ start a formula.
function cellValue(v) {
  if (typeof v !== 'string') return { value: v };
  if (v.startsWith("'")) return { value: v.slice(1) };
  const t = v.trim();
  if (t !== '' && /^[+-]?\d+(\.\d+)?$/.test(t)) return { value: Number(t) };
  if (/^[=+\-@]/.test(v)) return { value: '#ERROR!', formula: v };
  return { value: v };
}

class Sheet {
  constructor(name) { this.name = name; this.rows = []; this.formulas = []; }
  _set(r, c, v) {
    while (this.rows.length < r) this.rows.push([]);
    const row = this.rows[r - 1];
    while (row.length < c) row.push('');
    const x = cellValue(v);
    row[c - 1] = x.value;
    if (x.formula) this.formulas.push(x.formula);
  }
  _get(r, c) { const v = (this.rows[r - 1] || [])[c - 1]; return v === undefined ? '' : v; }
  appendRow(arr) { const r = this.rows.length + 1; arr.forEach((v, i) => this._set(r, i + 1, v)); return this; }
  getLastRow() { return this.rows.length; }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  getDataRange() {
    const w = Math.max(0, ...this.rows.map(r => r.length));
    return { getValues: () => this.rows.map(r => Array.from({ length: w }, (_, i) => r[i] === undefined ? '' : r[i])) };
  }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    return {
      setValue(v) { sh._set(r, c, v); return this; },
      setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => sh._set(r + i, c + j, v))); return this; },
      getValue() { return sh._get(r, c); },
      getValues() {
        return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => sh._get(r + i, c + j)));
      }
    };
  }
}

function formatDate(d, tz, fmt) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(d).map(x => [x.type, x.value]));
  return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
            .replace('HH', p.hour).replace('mm', p.minute);
}

// A backend instance: appscript.gs over fresh in-memory state. `clock.shift`
// moves "now" for the script (Date.now) and for the cache, to test expiry.
export function makeBackend({ log = () => {}, source = path.join(ROOT, 'appscript.gs') } = {}) {
  const clock = { shift: 0, now() { return Date.now() + this.shift; } };
  const sheets = new Map();
  const spreadsheet = {
    getSheetByName: n => sheets.get(n) || null,
    insertSheet: n => { const s = new Sheet(n); sheets.set(n, s); return s; }
  };
  const cacheMap = new Map();
  const liveCache = k => {
    const e = cacheMap.get(k);
    if (!e) return null;
    if (clock.now() > e.exp) { cacheMap.delete(k); return null; }
    return e.v;
  };
  const cache = {
    get: k => liveCache(k),
    put: (k, v, ttl = 600) => { cacheMap.set(k, { v: String(v), exp: clock.now() + Math.min(ttl, 21600) * 1000 }); },
    remove: k => { cacheMap.delete(k); },
    removeAll: ks => ks.forEach(k => cacheMap.delete(k))
  };
  const propMap = new Map();
  const props = {
    getProperty: k => (propMap.has(k) ? propMap.get(k) : null),
    setProperty: (k, v) => { propMap.set(k, String(v)); return props; },
    deleteProperty: k => { propMap.delete(k); return props; },
    getProperties: () => Object.fromEntries(propMap)
  };
  const outbox = [];

  const ctx = vm.createContext({
    SpreadsheetApp: { openById: () => spreadsheet },
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      // Java bytes: signed.
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest())
                                      .map(b => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      formatDate
    },
    MailApp: {
      sendEmail: o => { outbox.push({ to: o.to, subject: o.subject, body: o.body, at: clock.now() }); log('[mail] ' + o.subject); },
      getRemainingDailyQuota: () => 100
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@kiosk.test' }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: s => ({ content: s, setMimeType() { return this; } })
    },
    UrlFetchApp: { fetch: () => ({ getAllHeaders: () => ({}) }) },
    Logger: { log: (...a) => log('[gs] ' + a.join(' ')) },
    __clockNow: () => clock.now()
  });
  vm.runInContext('Date.now = __clockNow;', ctx);

  const src = fs.readFileSync(source, 'utf8');
  const swapped = src.replace(/const KEY_HASH = '[0-9a-f]{64}';/, `const KEY_HASH = '${sha256(LEGACY_TEST)}';`);
  if (swapped === src) throw new Error('KEY_HASH line not found in appscript.gs');
  vm.runInContext(swapped + '\n;globalThis.__api = { doGet, doPost };', ctx, { filename: 'appscript.gs' });
  const api = ctx.__api;

  // One request, as Apps Script would hand it over: query + form body merged
  // into e.parameter.
  function request({ method = 'POST', query = '', body = '' } = {}) {
    const parameter = { ...Object.fromEntries(new URLSearchParams(query)), ...Object.fromEntries(new URLSearchParams(body)) };
    const e = { parameter, queryString: query || null,
                postData: method === 'POST' ? { contents: body, type: 'application/x-www-form-urlencoded' } : undefined };
    return (method === 'POST' ? api.doPost(e) : api.doGet(e)).content;
  }

  // Shorthand for tests: an action with params, POSTed like apiCall does.
  function call(action, params = {}, opts = {}) {
    return JSON.parse(request({ method: opts.method || 'POST', query: opts.query || '',
                                body: new URLSearchParams({ action, ...params }).toString() }));
  }

  function seed() {
    const pl = spreadsheet.insertSheet('playlist');
    pl.appendRow(['id', 'title', 'type', 'url', 'duration', 'active', 'order', 'created',
                  'loop', 'fit', 'loops', 'text', 'heading']);
    pl.appendRow(['a1', 'הודעה לבדיקה', 'notice', '', 20, 'כן', 1, '13/10/2026', 'לא', '', 1,
                  'זו הודעה מהשרת המקומי', 'בדיקה מקומית']);
    pl.appendRow(['a2', 'שקופית', 'slide', '', 20, 'כן', 2, '13/10/2026', 'לא', '', 1,
                  'הפלייליסט כאן מדומה ולא נוגע במסך במשרד', '']);
  }

  return { call, request, seed, clock, sheets, propMap, cacheMap, outbox };
}

// ── The local server ──

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json',
                '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serve(port) {
  const be = makeBackend({ log: m => console.log(m), ...(process.env.KIOSK_GS ? { source: process.env.KIOSK_GS } : {}) });
  be.seed();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    if (url.pathname === '/exec') {
      let body = '';
      for await (const chunk of req) body += chunk;
      return send(200, 'application/json; charset=utf-8',
                  be.request({ method: req.method === 'POST' ? 'POST' : 'GET', query: url.search.slice(1), body }));
    }
    if (url.pathname === '/dev/outbox') return send(200, 'application/json; charset=utf-8', JSON.stringify(be.outbox, null, 2));
    if (url.pathname === '/dev/state') {
      const devices = [...be.propMap].filter(([k]) => k.startsWith('dev_')).map(([, v]) => JSON.parse(v));
      const pl = be.sheets.get('playlist');
      return send(200, 'application/json; charset=utf-8', JSON.stringify({
        devices, playlist: pl ? pl.rows : [], formulasWritten: pl ? pl.formulas : []
      }, null, 2));
    }
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    // Inside the project only, and never a dotfile (.env, .git, .clasp.json…).
    if (!file.startsWith(ROOT + path.sep) || rel.split('/').some(seg => seg.startsWith('.'))) return send(404, 'text/plain', 'not found');
    fs.readFile(file, (err, data) => {
      if (err) return send(404, 'text/plain', 'not found');
      if (rel === 'config.js') {
        data = String(data).replace(/SCRIPT_URL:\s*'[^']*'/, `SCRIPT_URL: 'http://${req.headers.host}/exec'`);
      }
      send(200, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', data);
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`kiosk local backend: http://127.0.0.1:${port}/  (old shared code for tests: ${LEGACY_TEST})`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve(Number(process.env.PORT) || 8124);
}
