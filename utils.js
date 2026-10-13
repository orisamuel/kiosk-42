/**
 * utils.js — shared utilities loaded by every page
 * Provides: apiCall, access code, theme, loading-screen, toast, formatting, sound.
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
// Always GET with URLSearchParams — keeps CORS simple, no preflight.
async function apiCall(action, params = {}) {
    if (typeof CONFIG === 'undefined') throw new Error('CONFIG not loaded');
    if (!CONFIG.SCRIPT_URL || CONFIG.SCRIPT_URL.includes('PASTE_')) {
        throw new Error('SCRIPT_URL not configured in config.js');
    }
    const key = getAccessKey();
    const url = CONFIG.SCRIPT_URL + '?' + new URLSearchParams(
        key ? { action, ...params, key } : { action, ...params });
    const res = await fetch(url, { redirect: 'follow' });
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
    toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span class="toast-msg">${message}</span>`;
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

// ── Access code ────────────────────────────────────────────
// The backend refuses every call without the access code (see appscript.gs).
// Each device keeps it in localStorage — the panel and the player share one
// origin, so a device that has it for one has it for both. It arrives once,
// through an access link (…#key=CODE), a code typed into the panel, or, for
// the screen, by being approved from the panel.

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

// Take the code from an access link and wipe it from the address bar, so it
// isn't left sitting in the tab or in a screenshot.
function adoptKeyFromHash() {
    const m = location.hash.match(/[#&]key=([^&]+)/);
    if (!m) return false;
    setAccessKey(decodeURIComponent(m[1]));
    history.replaceState(null, '', location.pathname + location.search);
    return true;
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
