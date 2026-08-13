/**
 * config.js — frontend configuration
 * Edit values here only. Same file is loaded by every page.
 */
const CONFIG = {

    // ── Google Apps Script web-app URL ───────────────────────
    // Paste the URL from: Apps Script editor → Deploy → Manage deployments
    SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyvbwOZEVuVCjwOGMkzfcm9mpEnYMSYGL2AQoV7xTHlEVrhi_wMy_F_n4mBjhlxZIrp/exec',

    // ── Direct link to the underlying Sheet (for "Open Sheet" buttons) ─
    SHEETS_URL: 'https://docs.google.com/spreadsheets/d/1sBuKpJyIpA_yZzQB0zIo9zQaM1Yb-ZZpE638tQRk3d4/edit',

    // ── App identity ─────────────────────────────────────────
    APP_NAME:     'הקיוסק של 42',
    APP_SUBTITLE: 'ניהול תוכן למסך המשרד',

    // ── Behavior ─────────────────────────────────────────────
    POLL_INTERVAL_MS:    3000,   // for live-dashboard pages
    AUTO_STOP_HOURS:     5,      // safety auto-stop for long-running poll loops
    NEW_ITEM_SOUND:      true,   // beep on new item (live dashboards)

    // ── Theme ────────────────────────────────────────────────
    DEFAULT_THEME: 'dark',       // 'dark' or 'light'
};
