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
// HELPERS
// ============================================================

function getSpreadsheet() {
  return SpreadsheetApp.openById(SHEET_ID);
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

// Types the player draws itself from text, with no address to fetch.
function isTextType(t) {
  return t === 'slide' || t === 'notice' || t === 'error';
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
        item: String(currentTitle),
        // Changes on every page load, so the panel can confirm a refresh landed.
        boot: bootId ? String(bootId) : '',
        // Files stored on the screen itself, so the admin panel can offer them.
        files: localFiles ? String(localFiles).split('|').filter(String) : [],
        // 'item title|why it would not play' — the panel shows this verbatim.
        fail: failNote ? String(failNote) : ''
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
    const sheet = ensureSheet('playlist', PLAYLIST_HEADERS);
    const data = sheet.getDataRange().getValues();
    let maxOrder = 0;
    for (let i = 1; i < data.length; i++) {
      maxOrder = Math.max(maxOrder, parseFloat(data[i][6]) || 0);
    }
    const id = Utilities.getUuid().substring(0, 8);
    sheet.appendRow([
      id,
      d.title,
      d.type || 'website',
      d.url,
      parseInt(d.duration) || 0,
      'כן',
      maxOrder + 1,
      fmtDate(new Date()),
      parseLoopsParam(d.loops) === 0 ? 'כן' : 'לא',
      d.fit === 'contain' || d.fit === 'cover' ? d.fit : '',
      parseLoopsParam(d.loops),
      d.text || '',
      d.heading || ''
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
    if (d.title !== undefined)    sheet.getRange(row, 2).setValue(d.title);
    if (d.type !== undefined)     sheet.getRange(row, 3).setValue(d.type);
    if (d.url !== undefined)      sheet.getRange(row, 4).setValue(d.url);
    if (d.duration !== undefined) sheet.getRange(row, 5).setValue(parseInt(d.duration) || 0);
    if (d.active !== undefined)   sheet.getRange(row, 6).setValue(d.active === 'true' || d.active === true ? 'כן' : 'לא');
    if (d.fit !== undefined)      sheet.getRange(row, 10).setValue(d.fit === 'contain' || d.fit === 'cover' ? d.fit : '');
    if (d.text !== undefined)     sheet.getRange(row, 12).setValue(d.text);
    if (d.heading !== undefined)  sheet.getRange(row, 13).setValue(d.heading);
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
    idleMessage:     map.idleMessage === undefined ? '' : String(map.idleMessage)
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
    const allowed = ['kioskName', 'refreshSeconds', 'defaultDuration', 'muted', 'showClock',
                     'dailyReloadHour', 'videoFit', 'idleMessage', 'gapSeconds'];
    allowed.forEach(k => {
      if (p[k] === undefined) return;
      let v = p[k];
      if (boolKeys.indexOf(k) !== -1) v = (v === 'true' || v === true || v === 'כן') ? 'כן' : 'לא';
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

// ============================================================
// KIOSK STATUS — heartbeat written by the player on every poll
// ============================================================

function getStatus() {
  try {
    const raw = CacheService.getScriptCache().get('kioskHeartbeat');
    if (!raw) return { success: true, ts: null };
    const hb = JSON.parse(raw);
    return { success: true, ts: hb.ts, item: hb.item, files: hb.files || [],
             boot: hb.boot || '', fail: hb.fail || '' };
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
    if (!url || !/^https?:\/\//i.test(url)) {
      return { success: true, embeddable: 'unknown', reason: 'כתובת לא תקינה' };
    }
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: false
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

function doGet(e)  { return doPost(e); }
function doPost(e) {
  try {
    if (!e || !e.parameter) return jsonResponse({ success: false, message: 'No parameters' });
    const action = e.parameter.action;
    const p = e.parameter;

    switch (action) {

      case 'ping':
        return jsonResponse({ success: true, version: 'v1' });

      // ── Playlist ──────────────────────────────────────────
      case 'getPlaylist':
        return jsonResponse(getPlaylist(p.current, p.files, p.boot, p.fail));
      case 'addItem':
        return jsonResponse(addItem({
          title: p.title, type: p.type, url: p.url, duration: p.duration,
          loops: p.loops, fit: p.fit, text: p.text, heading: p.heading
        }));
      case 'updateItem':
        return jsonResponse(updateItem({
          id: p.id, title: p.title, type: p.type, url: p.url,
          duration: p.duration, active: p.active, loops: p.loops, fit: p.fit,
          text: p.text, heading: p.heading
        }));
      case 'deleteItem':
        return jsonResponse(deleteItem(p.id));
      case 'moveItem':
        return jsonResponse(moveItem(p.id, p.dir));
      case 'reorderItems':
        return jsonResponse(reorderItems(p.ids));

      // ── Settings & kiosk control ─────────────────────────
      case 'updateSettings':
        return jsonResponse(updateSettings(p));
      case 'refreshKiosk':
        return jsonResponse(refreshKiosk());
      case 'getStatus':
        return jsonResponse(getStatus());
      case 'checkEmbed':
        return jsonResponse(checkEmbed(p.url));

      default:
        return jsonResponse({ success: false, message: 'Unknown action: ' + action });
    }
  } catch (e) {
    Logger.log('doPost error: ' + e);
    return jsonResponse({ success: false, message: e.toString() });
  }
}
