/**
 * Sign-in and photo-URL checks. No live network and no Supabase project.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
  clientIpFromHeaders,
  isInactiveCrew,
  matchPin,
  normalizePin,
  rateLimitExceeded,
  sortAccounts,
  PIN_MAX_FAILS_GLOBAL,
  PIN_MAX_FAILS_PER_IP,
  PIN_WINDOW_MS,
} from '../supabase/functions/_shared/pins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('PIN matching prefers owner, then office, then crew, and always checks every hash', () => {
  assert.equal(normalizePin('1234'), '1234');
  assert.equal(normalizePin(' 1234 '), '1234');
  assert.equal(normalizePin('123'), '');
  assert.equal(normalizePin('12345'), '');
  assert.equal(normalizePin('123456'), '');
  assert.equal(normalizePin('12a4'), '');

  const rows = [
    { kind: 'crew', crew_idx: 1, label: 'Brendon', pin_hash: 'c1' },
    { kind: 'office', office_id: 'ab', label: 'Pat', pin_hash: 'o' },
    { kind: 'crew', crew_idx: 0, label: 'Seth', pin_hash: 'c0' },
    { kind: 'owner', label: 'Will', pin_hash: 'own' },
  ];
  assert.deepEqual(sortAccounts(rows).map(r => r.label), ['Will', 'Pat', 'Seth', 'Brendon']);

  const seen = [];
  const found = matchPin('1111', rows, (pin, hash) => {
    seen.push(hash);
    return hash === 'own' || hash === 'c0';
  });
  assert.equal(found.label, 'Will');
  assert.deepEqual(seen, ['own', 'o', 'c0', 'c1']);
  assert.equal(matchPin('9999', rows, () => false), null);

  assert.equal(isInactiveCrew(0, { '0': true }), true);
  assert.equal(isInactiveCrew(1, { '0': true }), false);
  assert.equal(isInactiveCrew(0, null), false);
  assert.equal(isInactiveCrew(0, ['0']), false);

  const now = 1_000_000;
  const fails = Array.from({ length: PIN_MAX_FAILS_PER_IP }, () => ({ ip: '1.2.3.4', ok: false, at: now - 1000 }));
  assert.equal(rateLimitExceeded(fails, now, '1.2.3.4'), true);
  assert.equal(rateLimitExceeded(fails, now, '9.9.9.9'), false);
  assert.equal(rateLimitExceeded(fails.map(a => ({ ...a, at: now - PIN_WINDOW_MS - 1 })), now, '1.2.3.4'), false);
  const globalFails = Array.from({ length: PIN_MAX_FAILS_GLOBAL }, (_, i) => ({ ip: 'ip-' + i, ok: false, at: now - 1000 }));
  assert.equal(rateLimitExceeded(globalFails, now, 'fresh'), true);
  const nine = fails.slice(0, PIN_MAX_FAILS_PER_IP - 1);
  assert.equal(rateLimitExceeded([...nine, { ip: '1.2.3.4', ok: true, at: now - 1000 }], now, '1.2.3.4'), false);

  const headers = new Headers({ 'x-forwarded-for': ' 8.8.8.8 , 1.1.1.1 ' });
  assert.equal(clientIpFromHeaders(headers), '8.8.8.8');
});

test('the page does not fetch or contain the old client-side PIN check', () => {
  assert.equal(html.includes('let ADMIN_PIN'), false);
  assert.equal(html.includes("getKV('admin_pin')"), false);
  assert.equal(html.includes('getKV("admin_pin")'), false);
  assert.equal(html.includes("getKV('crew_pins')"), false);
  assert.equal(html.includes("getKV('office_users')"), false);
  assert.match(html, /functions\/v1\/pin-login/);
  assert.match(html, /function fpStoragePath/);
  assert.match(html, /_pinBuf\.length>=4/);
  assert.equal(html.includes('_pinBuf.length>=6'), false);
  assert.equal(html.includes('maxlength="6"'), false);
  assert.match(html, /await fpEnsureSession\(\);\s*const res=await fetch\(url,\{method,headers:sb\.headers/);
  assert.match(html, /async function fpStorageHeaders/);
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261009143000_rls_pin_auth_private_storage.sql'), 'utf8');
  assert.equal(migration.includes('ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY'), false);
  assert.match(migration, /private\.fp_member\(\)/);
  assert.match(migration, /crew_inactive/);
  assert.match(migration, /Crew ' \|\| \(v_key::int \+ 1\)/);
  const adminSrc = fs.readFileSync(path.join(root, 'supabase/functions/pin-admin/index.ts'), 'utf8');
  assert.match(adminSrc, /Crew \$\{crewIdx \+ 1\}/);
  assert.match(adminSrc, /scope: 'global'/);
  assert.match(adminSrc, /deleteUser/);
  assert.match(adminSrc, /session_nonce/);
  assert.equal(adminSrc.includes('requirePin(body.pin, 4, 6)'), false);
});

test('login goes through the server and stored photo URLs are signed without rewriting them', async () => {
  const calls = [];
  const virtualConsole = new VirtualConsole();
  const consoleErrors = [];
  virtualConsole.on('jsdomError', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/Could not parse CSS|css/i.test(msg)) return;
    consoleErrors.push(msg);
  });
  virtualConsole.on('error', (...args) => {
    consoleErrors.push(args.map(a => (a && a.stack) ? a.stack : String(a)).join(' '));
  });

  function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function mockFetch(url, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const u = String(url);
    let body = null;
    if (opts.body && typeof opts.body === 'string') {
      try { body = JSON.parse(opts.body); } catch { body = opts.body; }
    }
    const headers = opts.headers || {};
    calls.push({ url: u, method, body, authorization: headers.Authorization || headers.authorization || '' });

    if (u.includes('/functions/v1/pin-login')) {
      if (body && body.pin === '4821') {
        return Promise.resolve(jsonResponse({
          access_token: 'tok-owner',
          refresh_token: 'ref-owner',
          expires_in: 3600,
          account: { kind: 'owner', crew_idx: null, office_id: null, display_name: 'Will Bradford' },
        }));
      }
      if (body && body.pin === '1111') {
        return Promise.resolve(jsonResponse({
          access_token: 'tok-crew',
          refresh_token: 'ref-crew',
          expires_in: 3600,
          account: { kind: 'crew', crew_idx: 0, office_id: null, display_name: 'Seth West' },
        }));
      }
      return Promise.resolve(jsonResponse({ error: 'That PIN was not recognized.' }, 401));
    }
    if (u.includes('/functions/v1/pin-admin')) {
      return Promise.resolve(jsonResponse({ error: 'Sign in required.' }, 401));
    }
    if (u.includes('/storage/v1/object/sign/')) {
      const paths = (body && body.paths) || [];
      return Promise.resolve(jsonResponse(paths.map(p => ({
        path: p,
        signedURL: `/object/sign/vehicle-docs/${encodeURIComponent(p)}?token=signed`,
      }))));
    }
    if (u.includes('/rest/v1/crew')) {
      return Promise.resolve(jsonResponse([
        { id: 1, full_name: 'Seth West', first_name: 'Seth', initials: 'SW', color: '#6aabff', role: 'Installer', phone: '', specialties: '[]', hourly: '25', hours: '40', ss: '6.20', medicare: '1.45', futa: '2.70', wc: '10.00', gl: '3.00', benefits: '0', pto_days: '0', sort_order: 0 },
      ]));
    }
    if (u.includes('/rest/v1/')) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(new Response('', { status: 200 }));
  }

  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = mockFetch;
      window.AbortController = AbortController;
      window.CSS = window.CSS || { escape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); } };
    },
  });
  const w = dom.window;
  const call = (name, ...args) => w.eval(name).apply(undefined, args);
  try {
    await new Promise(r => setTimeout(r, 40));
    assert.equal(w.document.getElementById('login-screen').style.display, 'flex');
    const pinReads = calls.filter(c => /admin_pin|crew_pins|office_users/.test(c.url));
    assert.equal(pinReads.length, 0, 'boot must not download PIN rows: ' + JSON.stringify(pinReads));

    const publicUrl = 'https://cngbsmmdfxmerlqnkate.supabase.co/storage/v1/object/public/vehicle-docs/jobs/a%20b.jpg?download=1';
    assert.equal(call('fpStoragePath', publicUrl), 'jobs/a b.jpg');
    assert.equal(call('fpStoragePath', 'jobs/plain.jpg'), 'jobs/plain.jpg');
    const drive = 'https://drive.google.com/file/d/abc';
    assert.equal(call('fpStoragePath', drive), '');
    assert.equal(call('fpMediaUrl', drive), drive);
    assert.equal(call('fpMediaUrl', publicUrl), publicUrl);

    w.eval("_pinBuf='0000'");
    await call('pinSubmit');
    assert.equal(w.document.getElementById('login-screen').style.display, 'flex');
    assert.equal(calls.some(c => c.url.includes('/functions/v1/pin-login') && c.body && c.body.pin === '0000'), true);

    calls.length = 0;
    w.eval("_pinBuf='4821'");
    await call('pinSubmit');
    assert.equal(w.document.getElementById('login-screen').style.display, 'none');
    assert.equal(w.localStorage.getItem('fpRole'), null);
    await w.eval('sb').get('jobs');
    const jobGet = calls.find(c => c.url.includes('/rest/v1/jobs'));
    assert.ok(jobGet, 'expected a jobs read after sign-in');
    assert.equal(jobGet.authorization, 'Bearer tok-owner');

    w.eval('JOB_PHOTOS = { j1: [{ url: ' + JSON.stringify(publicUrl) + ', thumb: "jobs/thumb.jpg" }] }');
    const before = publicUrl;
    await call('fpWarmStoredMedia');
    const signed = call('fpMediaUrl', publicUrl);
    assert.notEqual(signed, before);
    assert.match(signed, /\/storage\/v1\/object\/sign\/vehicle-docs\//);
    assert.match(signed, /token=signed/);
    assert.equal(call('fpMediaUrl', drive), drive);
    assert.equal(w.eval('JOB_PHOTOS.j1[0].url'), publicUrl, 'saved JSON must stay the public URL string');

    let quiet = 0;
    let lastCount = -1;
    for (let i = 0; i < 30 && quiet < 3; i++) {
      await new Promise(r => setTimeout(r, 20));
      quiet = calls.length === lastCount ? quiet + 1 : 0;
      lastCount = calls.length;
    }
    const lateErrors = consoleErrors.filter(e => !/css/i.test(e));
    assert.equal(lateErrors.length, 0, lateErrors.join('\n'));
  } finally {
    try { w.eval('clearTimeout(_autoLockTimer)'); } catch { /* already gone */ }
    try { w._fpMediaHydrator && w._fpMediaHydrator.disconnect(); } catch { /* already gone */ }
    try { w.close(); } catch { /* timers */ }
  }
});
