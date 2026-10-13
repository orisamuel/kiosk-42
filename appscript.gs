// ============================================================
// הקיוסק של 42 — Google Apps Script Backend
// Stack: Google Sheets as DB, single web-app endpoint, action-based router
// ============================================================
//
// SETUP:
//   1. Replace SHEET_ID below with the ID of your Google Sheet
//      (the long string between /d/ and /edit in the Sheets URL).
//   2. Deploy → New deployment → Web app
//        - Execute as: Me
//        - Who has access: Anyone
//   3. Copy the deployed URL into frontend `config.js` → CONFIG.SCRIPT_URL.
//   4. EVERY time you edit this file you must redeploy:
//        Deploy → Manage deployments → ✏ edit → Version: New version → Deploy
//      (Otherwise the live URL keeps serving the OLD code.)
// ============================================================

const SHEET_ID = '1sBuKpJyIpA_yZzQB0zIo9zQaM1Yb-ZZpE638tQRk3d4';

// ============================================================
// ACCESS
// The script URL sits in config.js on a public site, so nothing here answers
// without a device key, except `ping` and the steps that connect a device.
//
// A device key is a random string the device made for itself. Only its
// SHA-256 is kept, in Script Properties (`dev_<hash>`), so nothing in this
// public file opens the screen, and each device can be disconnected on its
// own from the panel. A device connects once, by one of:
//   • an invite link made in a connected panel (one use, 24 hours);
//   • a 6-digit code emailed to the script owner (10 minutes, 5 tries);
//   • the screen: the code on its waiting board, typed into a connected panel.
// Requests are POST with a form body, so a key never sits in a URL. The owner
// gets an email whenever a device joins by invite or screen code. If no
// connected phone is at hand, ownerInvite() in the editor logs a fresh invite.
//
// Run setupMail() once from the editor after the first deploy of this: Google
// asks for the permission to send the emails.
// ============================================================

// The single shared code used before device keys. Until LEGACY_UNTIL it still
// works, so a device holding it can trade it for a key of its own (the panel
// and the screen do that by themselves on their next call). `retireLegacy`
// (from a connected phone) ends it sooner. After that it opens nothing, and
// KEY_HASH and KIOSK_KEY in .env can be deleted.
const KEY_HASH = '79484da10a11feccd1c377da9bd0c25350454ea0b96185054f8184573ab7e52a';
const LEGACY_UNTIL = new Date('2026-10-21T00:00:00+03:00').getTime();

const MIN_KEY_LEN    = 32;
const PAIR_TTL_MS    = 10 * 60 * 1000;      // emailed code
const PAIR_MAX_TRIES = 5;
const PAIR_GAP_MS    = 60 * 1000;           // one emailed code a minute
const PAIR_WINDOW_MS = 6 * 60 * 60 * 1000;  // …and PAIR_PER_WINDOW per 6 hours
const PAIR_PER_WINDOW = 6;
const INVITE_TTL_MS  = 24 * 60 * 60 * 1000;
const SCREEN_REQ_TTL = 600;                 // seconds a waiting screen's code lives
const SCREEN_REQ_MAX = 100;                 // new screen requests per 10 minutes
const SEEN_EVERY_MS  = 60 * 60 * 1000;      // "last seen" is written at most hourly
const SITE_URL       = 'https://orisamuel.github.io/kiosk-42/';

// Managing devices is for phones. The screen's key is the most exposed one
// (it sits on a wall, and its panel opens from a hidden corner), so it can
// change what plays but can't let anyone else in.
const PHONE_ONLY = ['listDevices', 'removeDevice', 'approveDevice', 'createInvite', 'retireLegacy'];

function sha256Hex(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function props_() {
  return PropertiesService.getScriptProperties();
}

// A failure to read Properties throws on (a server error, not "unknown
// device"), so a passing outage doesn't send the screen back to pairing.
function readDevice_(hash) {
  const raw = props_().getProperty('dev_' + hash);
  try { return JSON.parse(raw || 'null'); } catch (_) { return null; }
}

function saveDevice_(hash, kind, name, how) {
  const now = Date.now();
  const dev = {
    id: hash.slice(0, 10),
    kind: kind === 'screen' ? 'screen' : 'panel',
    name: cleanName_(name, kind === 'screen' ? 'מסך' : 'מכשיר'),
    since: now, seen: now, how: how
  };
  props_().setProperty('dev_' + hash, JSON.stringify(dev));
  return dev;
}

function registerDevice_(key, kind, name, how) {
  key = String(key || '');
  return key.length < MIN_KEY_LEN ? null : saveDevice_(sha256Hex(key), kind, name, how);
}

function cleanName_(s, fallback) {
  const n = String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40);
  return n || fallback;
}

// A short numeric code. getUuid() is random (v4); its first 48 bits are plenty.
function randomDigits_(n) {
  const x = parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 12), 16);
  return String(x % Math.pow(10, n)).padStart(n, '0');
}

// Who is calling: a connected device, the old shared code, or nobody (null).
function callerFor_(key) {
  key = String(key || '');
  if (!key) return null;
  const hash = sha256Hex(key);
  if (key.length >= MIN_KEY_LEN) {
    const dev = readDevice_(hash);
    if (dev) return { device: dev, hash: hash };
  }
  if (hash === KEY_HASH && Date.now() < LEGACY_UNTIL && props_().getProperty('LEGACY_OFF') !== '1') {
    return { legacy: true };
  }
  return null;
}

// Ends the old shared code now, once the screen and the phones that held it
// have their own keys (the device list shows them).
function retireLegacy() {
  props_().setProperty('LEGACY_OFF', '1');
  return { success: true, message: 'הקוד הישן בוטל' };
}

// A heads-up to the owner whenever a device joins by invite or screen code,
// so a pairing nobody expected doesn't go unnoticed. Never blocks the pairing.
function notifyOwner_(dev) {
  try {
    const how = dev.how === 'invite' ? 'בקישור גישה' : dev.how === 'screen' ? 'בקוד מסך' : dev.how;
    MailApp.sendEmail({
      to: Session.getEffectiveUser().getEmail(),
      subject: 'מכשיר חדש חובר לקיוסק של 42: ' + dev.name,
      body: 'מכשיר חדש חובר לניהול המסך במשרד: "' + dev.name + '" (' + how + ').\n\n' +
            'לא מוכר לך? מנתקים אותו בדף הניהול, ב"מכשירים מחוברים":\n' + SITE_URL
    });
  } catch (e) {
    Logger.log('notifyOwner_: ' + e);
  }
}

// "Last seen" for the device list. Re-read under the lock, so a device removed
// a moment ago isn't written back by its own request in flight.
function touchDevice_(caller) {
  if (!caller.device || Date.now() - (caller.device.seen || 0) < SEEN_EVERY_MS) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return;
  try {
    const dev = readDevice_(caller.hash);
    if (!dev) return;
    dev.seen = Date.now();
    props_().setProperty('dev_' + caller.hash, JSON.stringify(dev));
  } finally {
    lock.releaseLock();
  }
}

function listDevices(caller) {
  const all = props_().getProperties();
  const list = [];
  Object.keys(all).forEach(k => {
    if (k.indexOf('dev_') !== 0) return;
    try {
      const d = JSON.parse(all[k]);
      list.push({ id: d.id, name: d.name, kind: d.kind, since: d.since, seen: d.seen, how: d.how,
                  me: !!caller.hash && k === 'dev_' + caller.hash });
    } catch (_) {}
  });
  list.sort((a, b) => (a.since || 0) - (b.since || 0));
  return { success: true, devices: list };
}

function removeDevice(id) {
  id = String(id || '');
  if (!id) return { success: false, message: 'חסר מזהה מכשיר' };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const store = props_();
    const all = store.getProperties();
    const k = Object.keys(all).filter(k => k.indexOf('dev_') === 0).find(k => {
      try { return JSON.parse(all[k]).id === id; } catch (_) { return false; }
    });
    if (!k) return { success: false, message: 'המכשיר לא נמצא' };
    store.deleteProperty(k);
    return { success: true, message: 'המכשיר נותק' };
  } finally {
    lock.releaseLock();
  }
}

// A device with no other way in asks for a code. The code goes to the script
// owner (the account the web app runs as), never back to the device; the
// device gets `req` instead, and only the two together connect it. So nobody
// else can guess the code or burn its tries, and a new request replaces the
// old one. The limits are kept in Properties and checked under the lock, so a
// burst of requests can't slip past them.
function requestPair(p) {
  const code = randomDigits_(6);
  const req = Utilities.getUuid().replace(/-/g, '');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const store = props_();
    const now = Date.now();
    let rl = null;
    try { rl = JSON.parse(store.getProperty('PAIR_RL') || 'null'); } catch (_) {}
    if (!rl || now - rl.win > PAIR_WINDOW_MS) rl = { win: now, count: 0, last: 0 };
    if (now - rl.last < PAIR_GAP_MS) return { success: false, message: 'קוד נשלח לפני פחות מדקה. בודקים במייל' };
    if (rl.count >= PAIR_PER_WINDOW) {
      return { success: false, message: 'נשלחו יותר מדי קודים. אפשר לבקש קישור גישה ממי שכבר מחובר' };
    }
    rl.count++;
    rl.last = now;
    store.setProperty('PAIR_RL', JSON.stringify(rl));
    store.setProperty('PAIR', JSON.stringify({
      hash: sha256Hex(code), req: sha256Hex(req), exp: now + PAIR_TTL_MS, tries: 0
    }));
  } finally {
    lock.releaseLock();
  }
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    subject: 'קוד חיבור לקיוסק של 42: ' + code,
    body: 'מכשיר ביקש להתחבר לניהול המסך במשרד ("' + cleanName_(p.name, 'בלי שם') + '").\n\n' +
          'הקוד: ' + code + '\n' +
          'בתוקף 10 דקות, ועובד רק במכשיר שביקש אותו.\n\n' +
          'לא ידוע לך מי ביקש? לא למסור את הקוד. הוא יפוג לבד.'
  });
  return { success: true, req: req };
}

// Connect a device with an emailed code (plus the `req` its request got) or
// an invite. The device made `newKey` itself; only its hash is stored. Under
// the lock, so an invite works once and a code's tries are counted honestly.
function pair(p) {
  if (String(p.newKey || '').length < MIN_KEY_LEN) {
    return { success: false, message: 'מפתח לא תקין. מרעננים את הדף ומנסים שוב' };
  }
  const res = pairLocked_(p);
  if (res.device && res.device.how === 'invite') notifyOwner_(res.device);   // outside the lock
  return res.device ? { success: true, device: { id: res.device.id, name: res.device.name } } : res;
}

function pairLocked_(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const store = props_();
    let name = p.name, how;
    if (p.invite) {
      const k = 'inv_' + sha256Hex(String(p.invite));
      let inv = null;
      try { inv = JSON.parse(store.getProperty(k) || 'null'); } catch (_) {}
      if (inv) store.deleteProperty(k);
      if (!inv || Date.now() > inv.exp) {
        return { success: false, message: 'הקישור כבר נוצל או שפג תוקפו. מבקשים קישור חדש' };
      }
      if (inv.name) name = inv.name;
      how = 'invite';
    } else {
      let pr = null;
      try { pr = JSON.parse(store.getProperty('PAIR') || 'null'); } catch (_) {}
      if (!pr || Date.now() > pr.exp || pr.tries >= PAIR_MAX_TRIES) {
        return { success: false, message: 'הקוד פג. מבקשים קוד חדש' };
      }
      // Not the device that asked (or it asked again since): not counted as a try.
      if (!p.req || sha256Hex(String(p.req)) !== pr.req) {
        return { success: false, message: 'הקוד שייך לבקשה אחרת. מבקשים קוד חדש מהמכשיר הזה' };
      }
      if (sha256Hex(String(p.code || '').replace(/\D/g, '')) !== pr.hash) {
        pr.tries++;
        store.setProperty('PAIR', JSON.stringify(pr));
        return { success: false, message: pr.tries >= PAIR_MAX_TRIES ? 'יותר מדי ניסיונות. מבקשים קוד חדש' : 'הקוד לא נכון' };
      }
      store.deleteProperty('PAIR');
      how = 'mail';
    }
    return { device: registerDevice_(p.newKey, 'panel', name, how) };
  } finally {
    lock.releaseLock();
  }
}

// A one-time link for another phone. `name` (optional) is what the new device
// will be called in the list.
function createInvite(p, caller) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const store = props_();
  // Expired links are dropped on the way, so unused ones don't pile up.
  const all = store.getProperties();
  Object.keys(all).forEach(k => {
    if (k.indexOf('inv_') !== 0) return;
    let exp = 0;
    try { exp = JSON.parse(all[k]).exp; } catch (_) {}
    if (!(exp > Date.now())) store.deleteProperty(k);
  });
  store.setProperty('inv_' + sha256Hex(token), JSON.stringify({
    exp: Date.now() + INVITE_TTL_MS,
    name: cleanName_(p.name, ''),
    by: caller.device ? caller.device.id : caller.owner ? 'owner' : 'legacy'
  }));
  return { success: true, invite: token };
}

// Recovery that nobody else can block: run from the editor (Run ▸ ownerInvite)
// and open the link from the log on the phone to connect. For when no
// connected phone is at hand and the emailed code won't come.
function ownerInvite() {
  const res = createInvite({ name: 'אורי' }, { owner: true });
  Logger.log('קישור גישה לפעם אחת, 24 שעות: ' + SITE_URL + '#invite=' + res.invite);
}

// A screen with no key of its own yet (or one that was disconnected) asks for
// its playlist anyway. It gets a 6-digit code to show on its waiting board and
// is let in once someone types that code into a connected panel. The code is
// only ever shown on the screen that asked, so approving it proves the person
// is looking at that screen: a request from anywhere else carries a code
// nobody in the office can see.
function screenRequest(p) {
  const key = String(p.key || '');
  if (key.length < MIN_KEY_LEN) return { success: false, auth: 'denied', message: 'אין גישה' };
  const hash = sha256Hex(key);
  const cache = CacheService.getScriptCache();
  let code = cache.get('scrBy:' + hash);
  let req = code ? cache.get('scr:' + code) : null;
  if (!req) {
    const n = parseInt(cache.get('scrCount')) || 0;
    if (n >= SCREEN_REQ_MAX) return { success: false, auth: 'pair', message: 'יש כרגע יותר מדי בקשות חיבור' };
    cache.put('scrCount', String(n + 1), 600);
    do { code = randomDigits_(6); } while (cache.get('scr:' + code));
    req = JSON.stringify({ hash: hash, boot: String(p.boot || '').slice(0, 60),
                           name: cleanName_(p.name, 'מסך'), ts: Date.now() });
  }
  // Each poll keeps the code (and the panel's hint) alive while the screen waits.
  cache.put('scr:' + code, req, SCREEN_REQ_TTL);
  cache.put('scrBy:' + hash, code, SCREEN_REQ_TTL);
  const r = JSON.parse(req);
  cache.put('kioskPending', JSON.stringify({ ts: Date.now(), boot: r.boot, name: r.name }), SCREEN_REQ_TTL);
  return { success: false, auth: 'pair', code: code, message: 'המסך ממתין לחיבור בממשק הניהול' };
}

// Typed into a connected panel: the code the waiting screen shows.
function approveDevice(code) {
  code = String(code || '').replace(/\D/g, '');
  if (code.length !== 6) return { success: false, message: 'הקוד שעל המסך הוא 6 ספרות' };
  const cache = CacheService.getScriptCache();
  let req = null;
  try { req = JSON.parse(cache.get('scr:' + code) || 'null'); } catch (_) {}
  if (!req) return { success: false, message: 'אין מסך שממתין עם הקוד הזה. בודקים את הקוד שמופיע עכשיו על המסך' };
  const dev = saveDevice_(req.hash, 'screen', req.name, 'screen');
  cache.removeAll(['scr:' + code, 'scrBy:' + req.hash, 'kioskPending']);
  notifyOwner_(dev);
  return { success: true, boot: req.boot, device: { id: dev.id, name: dev.name }, message: 'המסך חובר' };
}

// A device that still holds the old shared code trades it for a key of its own.
function upgradeDevice(p, caller) {
  if (!caller.legacy) return { success: true, message: 'המכשיר כבר מחובר' };
  const dev = registerDevice_(p.newKey, p.kind, p.name, 'upgrade');
  if (!dev) return { success: false, message: 'מפתח לא תקין' };
  return { success: true, device: { id: dev.id, name: dev.name } };
}

// Run once from the editor (Run ▸ setupMail) so Google asks for the permission
// to send the emailed codes. Sends nothing.
function setupMail() {
  Logger.log('Codes go to ' + Session.getEffectiveUser().getEmail() +
             ' · mail quota left today: ' + MailApp.getRemainingDailyQuota());
}

// ============================================================
// HELPERS
// ============================================================

let spreadsheet_ = null;   // one open per request — openById is slow
function getSpreadsheet() {
  return spreadsheet_ || (spreadsheet_ = SpreadsheetApp.openById(SHEET_ID));
}

function getSheet(name) {
  return getSpreadsheet().getSheetByName(name);
}

// Auto-creates the sheet with the given headers if it doesn't exist.
// ALWAYS use this instead of getSheet() inside write functions.
function ensureSheet(name, headers) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    Logger.log('Created sheet: ' + name);
  }
  return sheet;
}

function fmtDate(d) {
  return Utilities.formatDate(d, 'Asia/Jerusalem', 'dd/MM/yyyy');
}

function fmtTime(d) {
  return Utilities.formatDate(d, 'Asia/Jerusalem', 'HH:mm');
}

// Normalize any date value (Date object or string) to dd/MM/yyyy.
function normalizeDate(v) {
  if (!v && v !== 0) return '';
  const s = String(v);
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return s;
  try {
    const dt = new Date(v);
    if (!isNaN(dt.getTime())) return fmtDate(dt);
  } catch (e) {}
  return s;
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// Find a row by value in a given column. Returns row index (1-based) or -1.
function findRow(sheet, colIndex, value) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][colIndex]) === String(value)) return i + 1;
  }
  return -1;
}

// ============================================================
// TABLE: PLAYLIST
// Schema: id(0), title(1), type(2), url(3), duration(4), active(5), order(6), created(7),
//         loop(8), fit(9), loops(10), text(11), heading(12)
//   type:     youtube | video | drive | local | website | image | slide | notice | error
//   url:      the address — empty for slide/notice, which carry text instead
//   text:     body text for slide/notice/error
//   heading:  OPTIONAL on-screen title for those types. Blank = show the text
//             alone. `title` is only the label in the admin list, never drawn.
//   duration: seconds. Videos ignore it unless set (they run on their own length);
//             websites/images fall back to defaultDuration.
//   active:   'כן' / 'לא'
//   loops:    how many times a video plays before the next item.
//             1 = once (default), N = N times, 0 = forever.
//   loop:     legacy 'כן'/'לא' infinite flag — kept in sync with loops for
//             readability in the sheet, and read when loops is blank.
//   fit:      '' (use the global videoFit setting) | 'contain' | 'cover'
//             Matters most on a portrait screen showing landscape video.
// ============================================================

const PLAYLIST_HEADERS = ['id', 'title', 'type', 'url', 'duration', 'active', 'order',
                          'created', 'loop', 'fit', 'loops', 'text', 'heading'];

const ITEM_TYPES = ['youtube', 'video', 'drive', 'local', 'website', 'image', 'slide', 'notice', 'error'];
const MAX_URL = 2000, MAX_TITLE = 200, MAX_TEXT = 2000, MAX_HEADING = 300;

// The player only lifts the video / file id out of these, but an address on
// another host under these types is a mistake worth catching at the door.
const YT_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
                  'youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com'];
const DRIVE_HOSTS = ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'];

// Types the player draws itself from text, with no address to fetch.
function isTextType(t) {
  return t === 'slide' || t === 'notice' || t === 'error';
}

// The host of an https:// address, or null. Plain http never played anyway:
// the player is an https page, and browsers block http content inside it.
function httpsHost_(url) {
  const m = /^https:\/\/([^\/?#\s]+)(?:[\/?#]|$)/i.exec(String(url || ''));
  if (!m || /[@\\]/.test(m[1])) return null;   // no user:password@ part
  const host = m[1].replace(/:\d+$/, '').toLowerCase();
  return host.indexOf('.') > 0 && !/[:\s]/.test(host) ? host : null;
}

// Why an item can't be saved, or '' when it can. Checked on every add and on
// every edit that touches the type or the address.
function itemProblem_(type, url) {
  if (ITEM_TYPES.indexOf(type) === -1) return 'סוג פריט לא מוכר';
  if (isTextType(type)) return '';
  url = String(url || '').trim();
  if (!url) return 'חסרה כתובת';
  if (url.length > MAX_URL) return 'הכתובת ארוכה מדי';
  if (type === 'local') {
    return url.length > 255 || /[\u0000-\u001f\u007f]/.test(url) ? 'שם הקובץ לא תקין' : '';
  }
  if (type === 'youtube' && /^[\w-]{11}$/.test(url)) return '';   // a bare video id
  if (type === 'drive' && /^[\w-]{20,}$/.test(url)) return '';    // a bare file id
  const host = httpsHost_(url);
  if (!host) return 'הכתובת צריכה להתחיל ב-https://';
  if (type === 'youtube' && YT_HOSTS.indexOf(host) === -1) return 'זו לא כתובת של יוטיוב';
  if (type === 'drive' && DRIVE_HOSTS.indexOf(host) === -1) return 'זו לא כתובת של גוגל דרייב';
  return '';
}

// Text for a cell. One that starts with = + - @ would be read by Sheets as a
// formula, so it gets the apostrophe that keeps it plain text (and that is not
// part of the value read back).
function cell_(s, max) {
  s = String(s === undefined || s === null ? '' : s).slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

// Play count: 0 = forever, N = N times. Blank falls back to the legacy
// loop flag so rows written before this column keep behaving the same.
function normalizeLoops(loopsCell, legacyLoopCell) {
  const raw = String(loopsCell === undefined || loopsCell === null ? '' : loopsCell).trim();
  if (raw === '') {
    return (legacyLoopCell === 'כן' || legacyLoopCell === true || legacyLoopCell === 'yes') ? 0 : 1;
  }
  if (raw === '0' || raw === '∞') return 0;
  const n = parseInt(raw);
  return isNaN(n) || n < 1 ? 1 : n;
}

// Single call used by BOTH the kiosk player and the admin page.
// Returns all items (admin needs inactive ones too — the player filters).
// If `currentTitle` is passed (only the player passes it), records a
// heartbeat in the script cache so the admin can see the screen is alive.
function getPlaylist(currentTitle, localFiles, bootId, failNote) {
  try {
    const sheet = ensureSheet('playlist', PLAYLIST_HEADERS);
    const data = sheet.getDataRange().getValues();
    // Migration: sheets created before the loop / fit / loops features lack those columns.
    if (data.length && String(data[0][8] || '') !== 'loop') {
      sheet.getRange(1, 9).setValue('loop');
    }
    if (data.length && String(data[0][9] || '') !== 'fit') {
      sheet.getRange(1, 10).setValue('fit');
    }
    if (data.length && String(data[0][10] || '') !== 'loops') {
      sheet.getRange(1, 11).setValue('loops');
    }
    if (data.length && String(data[0][11] || '') !== 'text') {
      sheet.getRange(1, 12).setValue('text');
    }
    if (data.length && String(data[0][12] || '') !== 'heading') {
      sheet.getRange(1, 13).setValue('heading');
    }
    const items = data.length <= 1 ? [] : data.slice(1)
      .map(r => ({
        id:       String(r[0] || ''),
        title:    String(r[1] || ''),
        type:     String(r[2] || 'website'),
        url:      String(r[3] || ''),
        duration: parseInt(r[4]) || 0,
        active:   r[5] === 'כן' || r[5] === true || r[5] === 'yes',
        order:    parseFloat(r[6]) || 0,
        created:  normalizeDate(r[7]),
        loops:    normalizeLoops(r[10], r[8]),
        loop:     normalizeLoops(r[10], r[8]) === 0,  // legacy: infinite?
        fit:      String(r[9] || ''),
        text:     String(r[11] || ''),
        heading:  String(r[12] || '')
      }))
      // Slides and notices have no url — they carry their own text.
      .filter(it => it.id && (it.url || it.text || it.heading))
      .sort((a, b) => a.order - b.order);

    if (currentTitle) {
      CacheService.getScriptCache().put('kioskHeartbeat', JSON.stringify({
        ts: Date.now(),
        item: String(currentTitle).slice(0, MAX_TITLE),
        // Changes on every page load, so the panel can confirm a refresh landed.
        boot: bootId ? String(bootId).slice(0, 60) : '',
        // Files stored on the screen itself, so the admin panel can offer them.
        files: localFiles ? String(localFiles).slice(0, 8000).split('|').filter(String) : [],
        // 'item title|why it would not play' — the panel shows this verbatim.
        fail: failNote ? String(failNote).slice(0, 500) : ''
      }), 21600);
    }

    return { success: true, items: items, settings: getSettingsMap() };
  } catch (e) {
    Logger.log('getPlaylist error: ' + e);
    return { success: false, message: e.toString(), items: [] };
  }
}

// Incoming HTTP params are strings; '' / missing → play once.
function parseLoopsParam(v) {
  if (v === undefined || v === null || String(v).trim() === '') return 1;
  const n = parseInt(v);
  if (isNaN(n) || n < 0) return 1;
  return n;  // 0 = forever
}

function addItem(d) {
  try {
    if (!d.title) return { success: false, message: 'חסר שם' };
    if (!d.url && !d.text && !d.heading) return { success: false, message: 'חסר כתובת או טקסט' };
    const type = d.type || 'website';
    const problem = itemProblem_(type, d.url);
    if (problem) return { success: false, message: problem };
    const sheet = ensureSheet('playlist', PLAYLIST_HEADERS);
    const data = sheet.getDataRange().getValues();
    let maxOrder = 0;
    for (let i = 1; i < data.length; i++) {
      maxOrder = Math.max(maxOrder, parseFloat(data[i][6]) || 0);
    }
    const id = Utilities.getUuid().substring(0, 8);
    sheet.appendRow([
      id,
      cell_(d.title, MAX_TITLE),
      type,
      cell_(String(d.url || '').trim(), MAX_URL),
      parseInt(d.duration) || 0,
      'כן',
      maxOrder + 1,
      fmtDate(new Date()),
      parseLoopsParam(d.loops) === 0 ? 'כן' : 'לא',
      d.fit === 'contain' || d.fit === 'cover' ? d.fit : '',
      parseLoopsParam(d.loops),
      cell_(d.text, MAX_TEXT),
      cell_(d.heading, MAX_HEADING)
    ]);
    return { success: true, message: 'נוסף לפלייליסט', id: id };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

function updateItem(d) {
  try {
    const sheet = getSheet('playlist');
    if (!sheet) return { success: false, message: 'גיליון playlist לא נמצא' };
    const row = findRow(sheet, 0, d.id);
    if (row === -1) return { success: false, message: 'פריט לא נמצא' };
    if (d.type !== undefined || d.url !== undefined) {
      const cur = sheet.getRange(row, 3, 1, 2).getValues()[0];   // type, url as stored
      const problem = itemProblem_(d.type !== undefined ? String(d.type) : String(cur[0] || 'website'),
                                   d.url !== undefined ? d.url : cur[1]);
      if (problem) return { success: false, message: problem };
    }
    if (d.title !== undefined)    sheet.getRange(row, 2).setValue(cell_(d.title, MAX_TITLE));
    if (d.type !== undefined)     sheet.getRange(row, 3).setValue(String(d.type));
    if (d.url !== undefined)      sheet.getRange(row, 4).setValue(cell_(String(d.url).trim(), MAX_URL));
    if (d.duration !== undefined) sheet.getRange(row, 5).setValue(parseInt(d.duration) || 0);
    if (d.active !== undefined)   sheet.getRange(row, 6).setValue(d.active === 'true' || d.active === true ? 'כן' : 'לא');
    if (d.fit !== undefined)      sheet.getRange(row, 10).setValue(d.fit === 'contain' || d.fit === 'cover' ? d.fit : '');
    if (d.text !== undefined)     sheet.getRange(row, 12).setValue(cell_(d.text, MAX_TEXT));
    if (d.heading !== undefined)  sheet.getRange(row, 13).setValue(cell_(d.heading, MAX_HEADING));
    if (d.loops !== undefined) {
      const n = parseLoopsParam(d.loops);
      sheet.getRange(row, 11).setValue(n);
      sheet.getRange(row, 9).setValue(n === 0 ? 'כן' : 'לא');
    }
    return { success: true, message: 'עודכן' };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// Hard delete — a playlist row has no history value once removed.
// (Temporary hiding is done with the active toggle instead.)
function deleteItem(id) {
  try {
    const sheet = getSheet('playlist');
    if (!sheet) return { success: false, message: 'גיליון playlist לא נמצא' };
    const row = findRow(sheet, 0, id);
    if (row === -1) return { success: false, message: 'פריט לא נמצא' };
    sheet.deleteRow(row);
    return { success: true, message: 'נמחק' };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// Move item one step up/down in display order.
// Normalizes all order values to 1..N as a side effect.
function moveItem(id, dir) {
  try {
    const sheet = ensureSheet('playlist', PLAYLIST_HEADERS);
    const data = sheet.getDataRange().getValues();
    const rows = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) rows.push({ row: i + 1, id: String(data[i][0]), order: parseFloat(data[i][6]) || 0 });
    }
    rows.sort((a, b) => a.order - b.order);
    const idx = rows.findIndex(r => r.id === String(id));
    if (idx === -1) return { success: false, message: 'פריט לא נמצא' };
    const j = dir === 'up' ? idx - 1 : idx + 1;
    if (j < 0 || j >= rows.length) return { success: true, message: 'כבר בקצה' };
    rows.forEach((r, k) => {
      let newOrder = k + 1;
      if (k === idx) newOrder = j + 1;
      if (k === j)   newOrder = idx + 1;
      if (r.order !== newOrder) sheet.getRange(r.row, 7).setValue(newOrder);
    });
    return { success: true };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// Persist a complete new display order in one call (used by drag & drop).
// `idsCsv` is a comma-separated list of item ids in the desired order.
// Rows not mentioned keep their relative position after the listed ones.
function reorderItems(idsCsv) {
  try {
    const sheet = ensureSheet('playlist', PLAYLIST_HEADERS);
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return { success: true };
    const wanted = String(idsCsv || '').split(',').filter(String);
    if (!wanted.length) return { success: false, message: 'לא התקבלה רשימת פריטים' };
    const pos = {};
    wanted.forEach((id, i) => { pos[id] = i + 1; });
    // Rows missing from the list keep their current relative order, after the listed ones.
    const rows = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) rows.push({ id: String(data[i][0]), order: parseFloat(data[i][6]) || 0 });
    }
    rows.sort((a, b) => a.order - b.order);
    let next = wanted.length;
    rows.forEach(r => { if (!(r.id in pos)) pos[r.id] = ++next; });
    // One batched write for the whole order column — much faster than per-cell writes.
    const colValues = [];
    for (let i = 1; i < data.length; i++) {
      const id = String(data[i][0]);
      colValues.push([pos[id] !== undefined ? pos[id] : (parseFloat(data[i][6]) || 0)]);
    }
    sheet.getRange(2, 7, colValues.length, 1).setValues(colValues);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// ============================================================
// TABLE: SETTINGS
// Schema: key(0), value(1) — key/value store, human-editable in the sheet
// ============================================================

const SETTINGS_DEFAULTS = {
  kioskName:       'הקיוסק של 42', // shown on the idle screen
  refreshSeconds:  60,             // how often the player re-fetches the playlist
  defaultDuration: 60,             // seconds, for websites/images without explicit duration
  muted:           'כן',           // mute videos ('כן'/'לא') — unmuted needs kiosk-browser autoplay permission
  showClock:       'כן',           // clock overlay on the player
  dailyReloadHour: 4,              // full page reload hour (0-23), -1 to disable
  reloadToken:     1,              // bumped by refreshKiosk → player reloads
  videoFit:        'cover',        // default fit for video/image: contain | cover
  gapSeconds:      10,             // waiting screen shown between items
  idleMessage:     'שטח פרסום זה יכול להיות שלך'  // shown on the waiting screen
};

function getSettingsMap() {
  const sheet = ensureSheet('settings', ['key', 'value']);
  const data = sheet.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < data.length; i++) map[String(data[i][0])] = data[i][1];
  Object.keys(SETTINGS_DEFAULTS).forEach(k => {
    if (!(k in map)) {
      sheet.appendRow([k, SETTINGS_DEFAULTS[k]]);
      map[k] = SETTINGS_DEFAULTS[k];
    }
  });
  const reloadHour = parseInt(map.dailyReloadHour);
  return {
    kioskName:       String(map.kioskName || ''),
    refreshSeconds:  Math.max(15, parseInt(map.refreshSeconds) || 60),
    defaultDuration: Math.max(5, parseInt(map.defaultDuration) || 60),
    muted:           map.muted === 'כן' || map.muted === true,
    showClock:       map.showClock === 'כן' || map.showClock === true,
    dailyReloadHour: isNaN(reloadHour) ? 4 : reloadHour,
    reloadToken:     parseInt(map.reloadToken) || 1,
    videoFit:        map.videoFit === 'contain' ? 'contain' : 'cover',
    gapSeconds:      Math.min(120, Math.max(0, isNaN(parseInt(map.gapSeconds)) ? 10 : parseInt(map.gapSeconds))),
    idleMessage:     map.idleMessage === undefined ? '' : String(map.idleMessage),
    // 'itemId|ms' — written by showNow; the screen acts on each new one once.
    showNow:         String(map.showNow || '')
  };
}

function setSettingRow(sheet, key, value) {
  const row = findRow(sheet, 0, key);
  if (row === -1) sheet.appendRow([key, value]);
  else sheet.getRange(row, 2).setValue(value);
}

function updateSettings(p) {
  try {
    const sheet = ensureSheet('settings', ['key', 'value']);
    getSettingsMap(); // make sure default rows exist
    const boolKeys = ['muted', 'showClock'];
    const numKeys = ['refreshSeconds', 'defaultDuration', 'dailyReloadHour', 'gapSeconds'];
    const allowed = ['kioskName', 'refreshSeconds', 'defaultDuration', 'muted', 'showClock',
                     'dailyReloadHour', 'videoFit', 'idleMessage', 'gapSeconds'];
    allowed.forEach(k => {
      if (p[k] === undefined) return;
      let v = p[k];
      if (boolKeys.indexOf(k) !== -1) v = (v === 'true' || v === true || v === 'כן') ? 'כן' : 'לא';
      else if (numKeys.indexOf(k) !== -1) { v = parseInt(v); if (isNaN(v)) return; }
      else if (k === 'videoFit') v = v === 'contain' ? 'contain' : 'cover';
      else v = cell_(v, 300);
      setSettingRow(sheet, k, v);
    });
    return { success: true, message: 'ההגדרות נשמרו' };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// Bump reloadToken → the player sees the change on its next poll and reloads.
function refreshKiosk() {
  try {
    const sheet = ensureSheet('settings', ['key', 'value']);
    const map = getSettingsMap();
    setSettingRow(sheet, 'reloadToken', (map.reloadToken || 1) + 1);
    return { success: true, message: 'המסך יתרענן בדקה הקרובה' };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// Ask the screen to jump to one item on its next check-in. Works for inactive
// items too — a one-off showing that then returns to the normal rotation.
function showNow(id) {
  try {
    const sheet = getSheet('playlist');
    if (!sheet || findRow(sheet, 0, id) === -1) return { success: false, message: 'פריט לא נמצא' };
    setSettingRow(ensureSheet('settings', ['key', 'value']), 'showNow', String(id) + '|' + Date.now());
    return { success: true, message: 'נשלח למסך' };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// ============================================================
// KIOSK STATUS — heartbeat written by the player on every poll
// ============================================================

function getStatus() {
  try {
    const cache = CacheService.getScriptCache();
    // A screen with no key yet, waiting for its code to be typed into a panel.
    // The code itself is never in here: it has to be read off the screen.
    let pending = null;
    try { pending = JSON.parse(cache.get('kioskPending') || 'null'); } catch (_) {}
    const raw = cache.get('kioskHeartbeat');
    if (!raw) return { success: true, ts: null, pending: pending };
    const hb = JSON.parse(raw);
    return { success: true, ts: hb.ts, item: hb.item, files: hb.files || [],
             boot: hb.boot || '', fail: hb.fail || '', pending: pending };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// ============================================================
// EMBED CHECK — server-side probe: does this site allow iframes?
// (Best effort — some sites block only at render time.)
// ============================================================

function checkEmbed(url) {
  try {
    url = String(url || '').trim();
    if (!httpsHost_(url)) {
      return { success: true, embeddable: 'unknown', reason: 'כתובת לא תקינה' };
    }
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true
    });
    const headers = resp.getAllHeaders();
    let xfo = '', csp = '';
    for (const k in headers) {
      const lk = k.toLowerCase();
      if (lk === 'x-frame-options') xfo = String(headers[k]);
      if (lk === 'content-security-policy') csp = String(headers[k]);
    }
    if (xfo && /deny|sameorigin/i.test(xfo)) {
      return { success: true, embeddable: false, reason: 'X-Frame-Options: ' + xfo };
    }
    if (csp) {
      const m = csp.match(/frame-ancestors([^;]*)/i);
      if (m && m[1].indexOf('*') === -1) {
        return { success: true, embeddable: false, reason: 'CSP frame-ancestors' };
      }
    }
    return { success: true, embeddable: true };
  } catch (e) {
    return { success: true, embeddable: 'unknown', reason: e.toString() };
  }
}

// ============================================================
// MAINTENANCE
// ============================================================

// Set up a time-based trigger to call this every 10 min — prevents cold starts.
// Apps Script editor → Triggers → Add Trigger → keepWarm → Time-driven → Every 10 min
function keepWarm() {
  Logger.log('keep-warm ' + new Date().toISOString());
}

// ============================================================
// HTTP ROUTER — single endpoint, switches on `action` parameter
// ============================================================

// GET answers `ping` only. Anything else would carry a key in its URL.
function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'ping') return jsonResponse({ success: true, version: 'v3' });
  return jsonResponse({ success: false, message: 'POST only' });
}

// POST with a form body (application/x-www-form-urlencoded): Apps Script reads
// it into e.parameter, and it needs no CORS preflight.
function doPost(e) {
  try {
    if (!e || !e.parameter) return jsonResponse({ success: false, message: 'No parameters' });
    const p = e.parameter;
    const action = p.action;
    // The key belongs in the body. One in the address is refused, not used.
    if (/(^|&)key=/.test(e.queryString || '')) {
      return jsonResponse({ success: false, auth: 'denied', message: 'אין גישה: מרעננים את הדף' });
    }

    // The only actions open to a device that isn't connected.
    switch (action) {
      case 'ping':        return jsonResponse({ success: true, version: 'v3' });
      case 'requestPair': return jsonResponse(requestPair(p));
      case 'pair':        return jsonResponse(pair(p));
    }

    const caller = callerFor_(p.key);
    if (!caller) {
      // The screen asking for its playlist is offered a code to be approved.
      if (action === 'getPlaylist' && p.boot) return jsonResponse(screenRequest(p));
      return jsonResponse({ success: false, auth: 'denied', message: 'אין גישה מהמכשיר הזה' });
    }
    touchDevice_(caller);
    if (caller.device && caller.device.kind === 'screen' && PHONE_ONLY.indexOf(action) !== -1) {
      return jsonResponse({ success: false, message: 'ניהול מכשירים אפשר רק מנייד מחובר, לא מהמסך' });
    }
    const res = route_(action, p, caller);
    // Still on the old shared code: the client swaps it for a key of its own.
    if (caller.legacy) res.legacy = true;
    return jsonResponse(res);
  } catch (e) {
    Logger.log('doPost error: ' + e);
    return jsonResponse({ success: false, message: e.toString() });
  }
}

function route_(action, p, caller) {
  switch (action) {

    // ── Playlist ──────────────────────────────────────────
    case 'getPlaylist':
      return getPlaylist(p.current, p.files, p.boot, p.fail);
    case 'addItem':
      return addItem({
        title: p.title, type: p.type, url: p.url, duration: p.duration,
        loops: p.loops, fit: p.fit, text: p.text, heading: p.heading
      });
    case 'updateItem':
      return updateItem({
        id: p.id, title: p.title, type: p.type, url: p.url,
        duration: p.duration, active: p.active, loops: p.loops, fit: p.fit,
        text: p.text, heading: p.heading
      });
    case 'deleteItem':
      return deleteItem(p.id);
    case 'moveItem':
      return moveItem(p.id, p.dir);
    case 'reorderItems':
      return reorderItems(p.ids);

    // ── Settings & kiosk control ─────────────────────────
    case 'updateSettings':
      return updateSettings(p);
    case 'refreshKiosk':
      return refreshKiosk();
    case 'showNow':
      return showNow(p.id);
    case 'getStatus':
      return getStatus();
    case 'checkEmbed':
      return checkEmbed(p.url);

    // ── Devices ──────────────────────────────────────────
    case 'listDevices':
      return listDevices(caller);
    case 'removeDevice':
      return removeDevice(p.id);
    case 'approveDevice':
      return approveDevice(p.code);
    case 'createInvite':
      return createInvite(p, caller);
    case 'upgradeDevice':
      return upgradeDevice(p, caller);
    case 'retireLegacy':
      return caller.device ? retireLegacy() : { success: false, message: 'רק ממכשיר עם מפתח משלו' };

    default:
      return { success: false, message: 'Unknown action: ' + action };
  }
}
