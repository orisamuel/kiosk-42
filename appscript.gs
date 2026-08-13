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
// Schema: id(0), title(1), type(2), url(3), duration(4), active(5), order(6), created(7)
//   type:     youtube | video | website | image
//   duration: seconds. 0 = play to end (videos) / use defaultDuration (websites, images)
//   active:   'כן' / 'לא'
// ============================================================

const PLAYLIST_HEADERS = ['id', 'title', 'type', 'url', 'duration', 'active', 'order', 'created'];

// Single call used by BOTH the kiosk player and the admin page.
// Returns all items (admin needs inactive ones too — the player filters).
// If `currentTitle` is passed (only the player passes it), records a
// heartbeat in the script cache so the admin can see the screen is alive.
function getPlaylist(currentTitle) {
  try {
    const sheet = ensureSheet('playlist', PLAYLIST_HEADERS);
    const data = sheet.getDataRange().getValues();
    const items = data.length <= 1 ? [] : data.slice(1)
      .map(r => ({
        id:       String(r[0] || ''),
        title:    String(r[1] || ''),
        type:     String(r[2] || 'website'),
        url:      String(r[3] || ''),
        duration: parseInt(r[4]) || 0,
        active:   r[5] === 'כן' || r[5] === true || r[5] === 'yes',
        order:    parseFloat(r[6]) || 0,
        created:  normalizeDate(r[7])
      }))
      .filter(it => it.id && it.url)
      .sort((a, b) => a.order - b.order);

    if (currentTitle) {
      CacheService.getScriptCache().put('kioskHeartbeat',
        JSON.stringify({ ts: Date.now(), item: String(currentTitle) }), 21600);
    }

    return { success: true, items: items, settings: getSettingsMap() };
  } catch (e) {
    Logger.log('getPlaylist error: ' + e);
    return { success: false, message: e.toString(), items: [] };
  }
}

function addItem(d) {
  try {
    if (!d.title || !d.url) return { success: false, message: 'חסר שם או כתובת' };
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
      fmtDate(new Date())
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
  reloadToken:     1               // bumped by refreshKiosk → player reloads
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
    reloadToken:     parseInt(map.reloadToken) || 1
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
    const allowed = ['kioskName', 'refreshSeconds', 'defaultDuration', 'muted', 'showClock', 'dailyReloadHour'];
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
    return { success: true, ts: hb.ts, item: hb.item };
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
        return jsonResponse(getPlaylist(p.current));
      case 'addItem':
        return jsonResponse(addItem({
          title: p.title, type: p.type, url: p.url, duration: p.duration
        }));
      case 'updateItem':
        return jsonResponse(updateItem({
          id: p.id, title: p.title, type: p.type, url: p.url,
          duration: p.duration, active: p.active
        }));
      case 'deleteItem':
        return jsonResponse(deleteItem(p.id));
      case 'moveItem':
        return jsonResponse(moveItem(p.id, p.dir));

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
