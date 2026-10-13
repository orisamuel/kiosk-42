/**
 * utils.js — shared utilities loaded by every page
 * Provides: apiCall, device key, theme, loading-screen, toast, formatting, sound.
 */

// ── Theme ──────────────────────────────────────────────────

function initTheme() {
    const saved = localStorage.getItem('app-theme') ||
                  (typeof CONFIG !== 'undefined' ? CONFIG.DEFAULT_THEME : 'dark');
    document.documentElement.dataset.theme = saved;
    updateThemeToggleIcon(saved);
}

function toggleTheme() {
    const current = document.documentElement.dataset.theme || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('app-theme', next);
    updateThemeToggleIcon(next);
}

function updateThemeToggleIcon(theme) {
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

// ── Loading screen ─────────────────────────────────────────

function updateLoadingProgress(text) {
    const el = document.getElementById('loadingProgress');
    if (el) el.textContent = text;
}

function hideLoadingScreen(delay = 400) {
    setTimeout(() => {
        const screen  = document.getElementById('loadingScreen');
        const content = document.getElementById('mainContent');
        if (screen)  screen.classList.add('hidden');
        if (content) content.classList.add('visible');
    }, delay);
}

// ── API ────────────────────────────────────────────────────

// Fire-and-forget ping. Call once on page load to warm Apps Script cold start.
function warmupServer() {
    if (typeof CONFIG === 'undefined' || !CONFIG.SCRIPT_URL) return;
    fetch(CONFIG.SCRIPT_URL + '?action=ping').catch(() => {});
}

// THE one and only way to call the backend.
// POST with a form body: the device key rides in the body, never in the URL
// (where it would end up in logs), and a form body is still a "simple" request,
// so there is no CORS preflight for Apps Script to trip over.
async function apiCall(action, params = {}) {
    if (typeof CONFIG === 'undefined') throw new Error('CONFIG not loaded');
    if (!CONFIG.SCRIPT_URL || CONFIG.SCRIPT_URL.includes('PASTE_')) {
        throw new Error('SCRIPT_URL not configured in config.js');
    }
    const key = getAccessKey();
    const body = new URLSearchParams(key ? { action, ...params, key } : { action, ...params });
    const res = await fetch(CONFIG.SCRIPT_URL, { method: 'POST', body, redirect: 'follow' });
    if (!res.ok) throw new Error('Server error: ' + res.status);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { return { success: true, raw: text }; }
}

// ── Toast notifications ────────────────────────────────────

(function initToastContainer() {
    if (typeof document === 'undefined') return;
    document.addEventListener('DOMContentLoaded', () => {
        if (!document.getElementById('toastContainer')) {
            const el = document.createElement('div');
            el.id = 'toastContainer';
            el.className = 'toast-container';
            document.body.appendChild(el);
        }
    });
})();

function showToast(message, type = 'info', duration = 3500) {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    // Plain text only: messages carry server replies and other sites' headers
    // (checkEmbed), and this page holds the device key.
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = icons[type] || 'ℹ';
    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = String(message);
    toast.append(icon, msg);
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-show'));
    setTimeout(() => {
        toast.classList.remove('toast-show');
        toast.classList.add('toast-hide');
        setTimeout(() => toast.remove(), 350);
    }, duration);
}

// alias kept for parity with older partyia code
function showStatus(message, type = 'info', duration = 5000) {
    showToast(message, type, duration);
}

// ── Device key ─────────────────────────────────────────────
// The backend answers only a connected device (see appscript.gs). Each device
// makes its own random key and keeps it in localStorage; the server keeps only
// its hash. A device is connected once: by an invite link, by a code emailed
// to Ori, or (the screen) by its code being typed into a connected panel. The
// panel and the player share one origin, so connecting one connects both.

const ACCESS_KEY_STORE = 'kioskKey';

function getAccessKey() {
    try { return localStorage.getItem(ACCESS_KEY_STORE) || ''; } catch (_) { return ''; }
}

function setAccessKey(k) {
    try {
        if (k) localStorage.setItem(ACCESS_KEY_STORE, k);
        else localStorage.removeItem(ACCESS_KEY_STORE);
    } catch (_) {}
}

// 32 random bytes, base64url: the key this device will be known by.
function newDeviceKey() {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return btoa(String.fromCharCode.apply(null, b))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// What this device is called in the panel's device list, unless named.
function deviceLabel() {
    const ua = navigator.userAgent || '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'נייד אנדרואיד' : 'מכשיר אנדרואיד';
    if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'מחשב Windows';
    return 'מכשיר';
}

// An old access link (…#key=CODE, the shared code from before device keys).
// Wiped from the address bar either way, and taken only by a device with no
// key yet, only while the server may still accept it, and only if it is short
// like that code: never over a working device key, and never a key someone
// else chose for this device.
const LEGACY_UNTIL_MS = Date.parse('2026-10-21T00:00:00+03:00');
function adoptKeyFromHash() {
    const m = location.hash.match(/[#&]key=([^&]+)/);
    if (!m) return false;
    history.replaceState(null, '', location.pathname + location.search);
    const code = decodeURIComponent(m[1]);
    if (getAccessKey() || code.length >= 32 || Date.now() >= LEGACY_UNTIL_MS) return false;
    setAccessKey(code);
    return true;
}

// An invite link (…#invite=TOKEN). Returns the token and wipes it from the
// address bar, so it isn't left sitting in the tab or in a screenshot.
function takeInviteFromHash() {
    const m = location.hash.match(/[#&]invite=([^&]+)/);
    if (!m) return '';
    history.replaceState(null, '', location.pathname + location.search);
    return decodeURIComponent(m[1]);
}

// The server marks its answers to the old shared code with `legacy`. Swap it
// for a key of this device's own, once, even with the panel and the player
// open side by side (the timestamp keeps a second tab from doing it too).
let keyUpgrade = null;
function upgradeLegacyKey(kind, name) {
    if (keyUpgrade) return keyUpgrade;
    try {
        if (Date.now() - (parseInt(localStorage.getItem('kioskKeyUpgrade')) || 0) < 30000) {
            return Promise.resolve(null);
        }
        localStorage.setItem('kioskKeyUpgrade', String(Date.now()));
    } catch (_) {}
    const legacy = getAccessKey();
    const fresh = newDeviceKey();
    keyUpgrade = apiCall('upgradeDevice', { newKey: fresh, kind, name })
        .then(res => {
            if (res && res.success && res.device && getAccessKey() === legacy) setAccessKey(fresh);
            return res;
        })
        .catch(() => null)
        .finally(() => { keyUpgrade = null; });
    return keyUpgrade;
}

// ── Formatting ─────────────────────────────────────────────

function formatCurrency(amount, symbol = '₪', locale = 'he-IL') {
    return symbol + Math.abs(amount).toLocaleString(locale);
}

function formatTime(ts, locale = 'he-IL') {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return ts;
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

// ── Sound (Web Audio API, no asset files needed) ──────────

function playNewItemSound() {
    if (typeof CONFIG !== 'undefined' && CONFIG.NEW_ITEM_SOUND === false) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const play = (freq, start, dur) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
            gain.gain.setValueAtTime(0.25, ctx.currentTime + start);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
            osc.start(ctx.currentTime + start);
            osc.stop(ctx.currentTime + start + dur);
        };
        play(880, 0, 0.18);
        play(1100, 0.2, 0.22);
    } catch (e) {}
}
