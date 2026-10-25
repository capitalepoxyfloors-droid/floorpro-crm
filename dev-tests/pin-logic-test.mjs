import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const vc = new VirtualConsole();
const errors = [];
vc.on('jsdomError', (err) => {
  const msg = String(err && err.message ? err.message : err);
  if (/css/i.test(msg)) return;
  errors.push(msg);
});
vc.on('error', (...args) => errors.push(args.map(String).join(' ')));

const calls = [];
const logs = [];
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const dom = new JSDOM(html, {
  url: 'http://127.0.0.1/?env=test',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.confirm = () => true;
    window.CSS = window.CSS || { escape(s) { return String(s); } };
    const origLog = window.console.log.bind(window.console);
    window.console.log = (...args) => {
      logs.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      origLog(...args);
    };
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      let body = null;
      if (opts.body && typeof opts.body === 'string') {
        try { body = JSON.parse(opts.body); } catch { body = opts.body; }
      }
      const headers = opts.headers || {};
      const auth = headers.Authorization || headers.authorization || '';
      calls.push({ u, body, method: opts.method || 'GET', auth });
      if (u.includes('/functions/v1/pin-login')) {
        if (body && body.action === 'roster') {
          return json({
            accounts: [
              { id: 'office-1', label: 'Remember Test Office', kind: 'office', pin_len: 6 },
              { id: 'crew-1', label: 'Remember Test Crew', kind: 'crew', pin_len: 4 },
            ],
          });
        }
        if (body && body.pin === '999999' && body.account_id === 'office-1') {
          return json({
            access_token: 'access-office',
            refresh_token: 'refresh-office',
            expires_in: 3600,
            account: { kind: 'office', office_id: 'tb', display_name: 'Remember Test Office', crew_idx: null },
          });
        }
        if (body && body.pin === '1111' && body.account_id === 'crew-1') {
          return json({
            access_token: 'access-crew',
            refresh_token: 'refresh-crew',
            expires_in: 3600,
            account: { kind: 'crew', crew_idx: 3, display_name: 'Remember Test Crew', office_id: null },
          });
        }
        return json({ error: 'Incorrect PIN — try again.' }, 401);
      }
      if (u.includes('grant_type=refresh_token')) {
        if (body && body.refresh_token === 'dead') return json({ error: 'invalid' }, 401);
        return json({ access_token: 'access-new', refresh_token: 'refresh-rotated', expires_in: 3600 });
      }
      if (u.includes('/functions/v1/pin-admin')) {
        if (String(auth).includes('stale-nonce')) return json({ error: 'no' }, 401);
        return json({ kind: 'office', display_name: 'Remember Test Office', office_id: 'tb', crew_idx: null });
      }
      if (u.includes('/logout')) return json({});
      return json([]);
    };
  },
});

const w = dom.window;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const evalFn = (src) => w.eval(src);
const $ = (id) => w.document.getElementById(id);
const blob = () => {
  const raw = w.localStorage.getItem('fpAuth_v2');
  return raw ? JSON.parse(raw) : null;
};
const bootFresh = async (data) => {
  $('login-screen').style.display = 'none';
  w.localStorage.setItem('fpAuth_v2', JSON.stringify(data));
  await evalFn('fpBootAuth()');
  await sleep(50);
};
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };

await sleep(50);
evalFn('loadAllFromSupabase = async function(){ return true; }');
evalFn('showPage = function(){}');
evalFn('showToast = function(){}');
evalFn('logAudit = function(){}');

for (let i = 0; i < 40 && !$('login-roster').textContent.includes('Remember Test Office'); i++) await sleep(25);
if (!$('login-roster').textContent.includes('Remember Test Office')) fail('roster did not render');

const form = $('pin-login-form');
const pw = $('password');
const un = $('username');
if (!form || form.getAttribute('method') !== 'post' || form.getAttribute('autocomplete') !== 'on') fail('form markup');
if (pw.type !== 'password' || pw.getAttribute('inputmode') !== 'numeric' || pw.getAttribute('autocomplete') !== 'current-password' || pw.name !== 'password' || pw.id !== 'password') fail('password markup ' + pw.outerHTML);
if (un.getAttribute('autocomplete') !== 'username' || un.name !== 'username' || un.id !== 'username') fail('username markup');
if ($('login-pin').style.display !== 'none') fail('keypad should be hidden on the name step');
if ($('pin-remember-wrap').style.display !== 'none') fail('remember should be hidden before a person is chosen');

// Typed / filled entry submits through the form, and Remember sticks for office.
un.value = 'Remember Test Office';
pw.value = '999999';
un.dispatchEvent(new w.Event('input', { bubbles: true }));
pw.dispatchEvent(new w.Event('input', { bubbles: true }));
await sleep(80);
if ($('login-screen').style.display === 'none') fail('filled field must not submit by itself');
if (!$('pd0').classList.contains('filled') || !$('pd5').classList.contains('filled')) fail('dots did not follow the field');
if ($('pin-remember-wrap').style.display !== 'flex') fail('remember should show for office');
$('pin-remember').checked = true;
form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
for (let i = 0; i < 40 && $('login-screen').style.display !== 'none'; i++) await sleep(25);
if ($('login-screen').style.display !== 'none') fail('office typed submit did not sign in');
let b = blob();
if (!b || b.remember !== true || b.refresh_token !== 'refresh-office' || b.kind !== 'office') fail('office remember blob ' + JSON.stringify(b));
if (pw.value !== '') fail('PIN left in the field after sign-in');
if (logs.some(l => l.includes('999999') || l.includes('1111'))) fail('PIN was written to the console');

// Sign out clears the remembered session and asks the server to drop this device only.
calls.length = 0;
await evalFn('pinLogout()');
await sleep(30);
if (w.localStorage.getItem('fpAuth_v2') !== null) fail('sign-out left fpAuth_v2');
if (!calls.some(c => c.u.includes('/logout') && c.u.includes('scope=local') && c.auth.includes('access-office'))) fail('sign-out did not revoke this device: ' + JSON.stringify(calls.map(c => c.u)));
if ($('login-screen').style.display !== 'flex') fail('sign-out did not return to the sign-in screen');

// Keypad still signs in, and a crew account cannot remember even if the box was checked.
$('pin-remember').checked = true;
un.value = 'Remember Test Crew';
pw.value = '1111';
form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
for (let i = 0; i < 40 && $('login-screen').style.display !== 'none'; i++) await sleep(25);
b = blob();
if (!b || b.remember !== false || b.kind !== 'crew' || b.role !== 'crew') fail('crew blob ' + JSON.stringify(b));
if ($('pin-remember-wrap').style.display !== 'none') fail('remember stayed visible for crew');

// Keypad path on the office account.
await evalFn('pinLogout()');
await sleep(40);
// Last person was crew, so the PIN step is already up. Switch with the keypad after picking office from the roster.
evalFn('pinShowRoster()');
for (let i = 0; i < 40 && !$('login-roster').textContent.includes('Remember Test Office'); i++) await sleep(25);
const buttons = [...$('login-roster').querySelectorAll('button')];
const officeBtn = buttons.find(btn => btn.textContent.includes('Remember Test Office'));
if (!officeBtn) fail('no office roster button');
officeBtn.click();
await sleep(20);
if ($('login-pin').style.display === 'none') fail('keypad hidden after picking a name');
if ($('pin-remember-wrap').style.display !== 'flex') fail('remember hidden for picked office user');
for (const d of [9, 9, 9, 9, 9, 9]) evalFn('pinKey(' + d + ')');
for (let i = 0; i < 40 && $('login-screen').style.display !== 'none'; i++) await sleep(25);
b = blob();
if ($('login-screen').style.display !== 'none' || !b || b.remember !== false || b.kind !== 'office') fail('keypad sign-in ' + JSON.stringify(b) + ' screen ' + $('login-screen').style.display);

// Forged remember on a crew blob still uses the 24h lock.
b.kind = 'crew'; b.role = 'crew'; b.remember = true; b.ts = Date.now() - 25 * 3600 * 1000;
b.refresh_token = 'refresh-crew'; b.expires_at = Date.now() + 3600000;
w.localStorage.setItem('fpAuth_v2', JSON.stringify(b));
await evalFn('fpBootAuth()');
await sleep(40);
if ($('login-screen').style.display !== 'flex' || w.localStorage.getItem('fpAuth_v2')) fail('crew 25h remember was kept');

// Office without remember, 25h idle, is locked.
w.localStorage.setItem('fpAuth_v2', JSON.stringify({
  refresh_token: 'refresh-office', access_token: 'access-office', expires_at: Date.now() + 3600000,
  kind: 'office', role: 'admin', remember: false, ts: Date.now() - 25 * 3600 * 1000,
  display_name: 'Remember Test Office', office_id: 'tb',
}));
await evalFn('fpBootAuth()');
await sleep(30);
if ($('login-screen').style.display !== 'flex' || w.localStorage.getItem('fpAuth_v2')) fail('office 25h without remember was kept');

// Office with remember, 25h idle, refreshes an expired access token and stays signed in.
await bootFresh({
  refresh_token: 'refresh-office', access_token: 'access-office', expires_at: Date.now() - 5000,
  kind: 'office', role: 'admin', remember: true, ts: Date.now() - 25 * 3600 * 1000,
  display_name: 'Remember Test Office', office_id: 'tb',
});
b = blob();
if ($('login-screen').style.display !== 'none' || evalFn('_sessionAuthed') !== true) fail('remembered office was locked at 25h ' + JSON.stringify(b) + ' authed ' + evalFn('_sessionAuthed'));
if (!b || b.refresh_token !== 'refresh-rotated' || b.access_token !== 'access-new' || b.remember !== true) fail('refresh did not rotate ' + JSON.stringify(b));

// Eight weeks idle still locks a remembered device.
b.ts = Date.now() - 57 * 24 * 3600 * 1000;
w.localStorage.setItem('fpAuth_v2', JSON.stringify(b));
await evalFn('fpBootAuth()');
await sleep(30);
if ($('login-screen').style.display !== 'flex' || w.localStorage.getItem('fpAuth_v2')) fail('8-week idle remember was kept');

// A still-valid access token whose nonce was bumped (PIN change) cannot stay signed in.
w.localStorage.setItem('fpAuth_v2', JSON.stringify({
  refresh_token: 'refresh-office', access_token: 'stale-nonce', expires_at: Date.now() + 3600000,
  kind: 'office', role: 'admin', remember: true, ts: Date.now(),
  display_name: 'Remember Test Office', office_id: 'tb',
}));
await evalFn('fpBootAuth()');
await sleep(40);
if ($('login-screen').style.display !== 'flex' || w.localStorage.getItem('fpAuth_v2')) fail('stale nonce session was kept');

// A dead refresh token (sessions deleted by a PIN change) clears a remembered device.
w.localStorage.setItem('fpAuth_v2', JSON.stringify({
  refresh_token: 'dead', access_token: 'access-office', expires_at: Date.now() - 5000,
  kind: 'office', role: 'admin', remember: true, ts: Date.now(),
  display_name: 'Remember Test Office', office_id: 'tb',
}));
await evalFn('fpBootAuth()');
await sleep(40);
if ($('login-screen').style.display !== 'flex' || w.localStorage.getItem('fpAuth_v2')) fail('dead refresh was kept');

if (errors.length) fail('console errors:\n' + errors.join('\n'));
if (process.exitCode) {
  console.error('pin logic test failed');
} else {
  console.log('pin logic test passed');
}
try { w.close(); } catch { /* jsdom timers */ }
process.exit(process.exitCode || 0);
