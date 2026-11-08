/**
 * Daily-log save and session reliability. Synthetic jobs only. No live network.
 * Saved is shown only after the server acknowledges that exact revision.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const DAY = '2026-11-02';

const state = {
  settings: {},
  rpc: [],
  calls: [],
  writes: [],
  patch: null,
  hold: null,
  whoami: 'ok',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function jobOf(note, stamp) {
  return {
    id: 'north',
    customer: 'North Warehouse',
    value: '18500',
    startDate: DAY,
    endDate: DAY,
    updated_at: stamp,
    dayLogs: { [DAY]: { notes: note, startTime: '7:50 AM', endTime: '3:10 PM', crewPresent: [{ crewIdx: 0, name: 'Avery Cole', startTime: '7:50 AM', endTime: '3:10 PM' }] } },
  };
}
function mockFetch(url, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const u = String(url);
  let body = null;
  if (opts.body && typeof opts.body === 'string') {
    try { body = JSON.parse(opts.body); } catch { body = opts.body; }
  }
  if (u.includes('/auth/v1/token')) return Promise.resolve(jsonResponse({ access_token: 'access-office', refresh_token: 'refresh-office', expires_in: 3600 }));
  if (u.includes('/functions/v1/pin-admin')) {
    if (state.whoami === 'down') return Promise.resolve(jsonResponse({ error: 'down' }, 503));
    if (state.whoami === 'deny') return Promise.resolve(jsonResponse({ error: 'no' }, 401));
    if (state.whoami === 'slow') {
      return new Promise(resolve => {
        state.hold = () => resolve(jsonResponse({ kind: 'office', display_name: 'Ops Reviewer', office_id: 'ops' }));
      });
    }
    return Promise.resolve(jsonResponse({ kind: 'office', display_name: 'Ops Reviewer', office_id: 'ops' }));
  }
  if (u.includes('/rest/v1/rpc/')) state.calls.push(u);
  if (u.includes('/rest/v1/rpc/fp_patch_job_records')) {
    state.rpc.push(body);
    const reply = () => {
      if (state.patch === 'stale') return jsonResponse({ message: 'stale_job' }, 409);
      if (state.patch === 'down') return jsonResponse({ message: 'no' }, 500);
      if (state.patch === 'deny') return jsonResponse({ message: 'no' }, 403);
      if (state.patch === 'missing') return jsonResponse({ code: 'PGRST202', message: 'Could not find the function public.fp_patch_job_records' }, 404);
      if (state.patch === 'offline') return Promise.reject(new TypeError('offline'));
      const sent = body && body.patches && body.patches[0];
      const note = sent && sent.patch && sent.patch.dayLogs && sent.patch.dayLogs[DAY] && sent.patch.dayLogs[DAY].notes;
      const stamp = '2026-11-07T18:00:00.000Z';
      const stored = jobOf(note || 'old note', stamp);
      if (sent && sent.patch) Object.assign(stored, sent.patch, { id: 'north', updated_at: stamp });
      state.settings.job_records = JSON.stringify([stored]);
      return jsonResponse({ ok: true, jobs: [stored] });
    };
    if (state.patch === 'delay') {
      return new Promise(resolve => { state.hold = () => resolve(reply()); });
    }
    return Promise.resolve(reply());
  }
  if (u.includes('/rest/v1/settings')) {
    if (method === 'GET') {
      if (Object.prototype.hasOwnProperty.call(state.settings, 'job_records')) {
        return Promise.resolve(jsonResponse([{ key: 'job_records', value: state.settings.job_records }]));
      }
      return Promise.resolve(jsonResponse([]));
    }
    if (method === 'POST' && body && body.key) {
      state.writes.push(body.key);
      state.settings[body.key] = body.value;
      return Promise.resolve(jsonResponse([body]));
    }
  }
  if (method === 'GET') return Promise.resolve(jsonResponse([]));
  if (method === 'POST') return Promise.resolve(jsonResponse([{ id: 1 }]));
  return Promise.resolve(new Response(null, { status: 204 }));
}

let dom;
let w;
function ev(src) { return w.eval(src); }
function call(name, ...args) {
  w.__fpArgs = args;
  return w.eval(name + '.apply(undefined, window.__fpArgs)');
}
function statusText() {
  return [...w.document.querySelectorAll('[data-jc-save-status]')].map(el => el.textContent).filter(Boolean)[0] || '';
}
function openLog(note) {
  const job = jobOf(note, '2026-11-07T17:00:00.000Z');
  w.__jobs = [JSON.parse(JSON.stringify(job))];
  ev('JOB_RECORDS.splice(0, JOB_RECORDS.length, ...window.__jobs)');
  w.__base = [JSON.parse(JSON.stringify(job))];
  ev('_jrBaseline = window.__base');
  ev("_jcId='north'");
  call('openJobCard', 'north');
  call('jcTab', 'log');
}
function notesBox() {
  const boxes = [...w.document.querySelectorAll('#jc-day-logs textarea')];
  return boxes.find(el => (el.getAttribute('placeholder') || '').toLowerCase().includes('noting')) || null;
}
function typeNote(note) {
  call('jcLogSet', DAY, 'notes', note);
  const box = notesBox();
  if (box) box.value = note;
}

test.before(async () => {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  dom = new JSDOM(html, {
    url: 'http://127.0.0.1/?env=test',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = mockFetch;
      window.AbortController = AbortController;
      window.confirm = () => true;
      window.CSS = window.CSS || { escape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); } };
    },
  });
  w = dom.window;
  await new Promise(r => setTimeout(r, 50));
  ev(`CREW_DATA[0].name='Avery'; CREW_DATA[0].full='Avery Cole'; CREW_DATA[0].hourly='';`);
  ev(`if(CREW[0]){ CREW[0].name='Avery'; CREW[0].full='Avery Cole'; }`);
  w.localStorage.setItem('fpOfficeUser', 'Ops Reviewer');
  w.localStorage.removeItem('fpRole');
  ev('_jrNow=function(){ return new Date("2026-11-07T23:30:00.000Z"); }');
});
test.after(() => { if (w) w.close(); });

test('a real server acknowledgement stamps Saved in Central time, and a no-op does not', async () => {
  state.rpc.length = 0;
  state.patch = 'ok';
  openLog('old note');
  assert.equal(statusText(), '');
  typeNote('poured the primer');
  assert.equal(statusText(), 'Unsaved changes');
  await call('saveJobCard');
  assert.ok(state.rpc.length >= 1);
  assert.equal(state.rpc[0].patches[0].patch.dayLogs[DAY].notes, 'poured the primer');
  assert.equal(ev('JOB_RECORDS[0].dayLogs["' + DAY + '"].startTime'), '7:50 AM');
  assert.equal(statusText(), 'Saved 5:30 PM');
  const acked = statusText();
  const sent = state.rpc.length;
  await call('saveJobCard');
  assert.equal(state.rpc.length, sent);
  assert.equal(statusText(), acked);
  assert.equal(ev('_jrLastSave.noop'), true);
  assert.equal(w.document.getElementById('modal-jobcard').classList.contains('open'), true);
  assert.equal(w.document.getElementById('save-badge'), null);
});

test('an older response cannot mark a newer edit saved', async () => {
  state.rpc.length = 0;
  state.patch = 'delay';
  state.hold = null;
  openLog('old note');
  typeNote('first draft');
  const pending = call('saveJobCard');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(statusText(), 'Saving…');
  typeNote('second draft');
  assert.equal(statusText(), 'Unsaved changes');
  state.hold();
  await pending;
  assert.equal(statusText(), 'Unsaved changes');
  assert.equal(ev('JOB_RECORDS[0].dayLogs["' + DAY + '"].notes'), 'second draft');
  state.patch = 'ok';
  await call('saveJobCard');
  assert.equal(statusText(), 'Saved 5:30 PM');
  assert.equal(ev('JOB_RECORDS[0].dayLogs["' + DAY + '"].notes'), 'second draft');
});

test('offline, 403, and 500 keep the draft and retry once', async () => {
  for (const mode of ['offline', 'deny', 'down']) {
    state.rpc.length = 0;
    state.patch = mode;
    openLog('old note');
    typeNote('keep this');
    await call('saveJobCard');
    assert.equal(ev('JOB_RECORDS[0].dayLogs["' + DAY + '"].notes'), 'keep this');
    assert.match(statusText(), /Not saved/);
    if (mode === 'offline') assert.match(statusText(), /offline/);
    else assert.match(statusText(), /Your note is still here/);
    const retry = w.document.querySelector('[data-jc-save-retry]');
    assert.equal(retry.style.display, 'inline-flex');
    assert.ok(retry.getBoundingClientRect || retry.style.minHeight !== undefined);
    state.patch = 'ok';
    retry.click();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(statusText(), 'Saved 5:30 PM');
    assert.equal(state.rpc.length, 2);
  }
});

test('a double tap sends one patch', async () => {
  state.rpc.length = 0;
  state.patch = 'delay';
  openLog('old note');
  typeNote('one save');
  const first = call('saveJobCard');
  const second = call('saveJobCard');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(state.rpc.length, 1);
  state.hold();
  await first;
  await second;
  assert.equal(state.rpc.length, 1);
});

test('a stale save lists the conflict and does not overwrite the other edit', async () => {
  state.patch = 'stale';
  state.rpc.length = 0;
  state.calls.length = 0;
  openLog('old note');
  ev(`JOB_RECORDS[0].dayLogs['${DAY}'].task='Prime'; _jrBaseline[0].dayLogs['${DAY}'].task='Prime';`);
  typeNote('my version');
  const server = jobOf('their version', '2026-11-07T18:05:00.000Z');
  server.dayLogs[DAY].task = 'Second coat';
  state.settings.job_records = JSON.stringify([server]);
  const noteField = notesBox();
  if (!noteField) throw new Error('notes box missing: ' + (w.document.getElementById('jc-day-logs')?.innerHTML || '').slice(0, 240));
  noteField.value = 'my version';
  noteField.dispatchEvent(new w.Event('input', { bubbles: true }));
  w.document.querySelector('#jc-day-logs .jc-save-row .btn-primary').click();
  await new Promise(r => setTimeout(r, 80));
  assert.match(statusText(), /Your note hasn’t been saved/);
  assert.equal(ev(`JOB_RECORDS[0].dayLogs['${DAY}'].notes`), 'my version');
  const shown = w.document.body.textContent;
  assert.match(shown, /Your note/);
  assert.match(shown, /Saved note/);
  assert.match(shown, /my version/);
  assert.match(shown, /their version/);
  assert.equal(shown.includes('Left as they saved'), false);
  assert.equal(shown.includes('Save this choice'), false);
  assert.equal(shown.includes('Keep yours'), false);
  assert.equal(shown.includes('Second coat'), false);
  assert.equal(shown.includes('keeps your note and replaces'), false);
  assert.match(w.document.querySelector('#jc-day-logs [data-jc-save-conflicts]').textContent, /Choose which note to keep/);
  const logPanel = w.document.querySelector('#jc-day-logs [data-jc-save-conflicts]');
  const footPanel = w.document.querySelector('#jc-footer [data-jc-save-conflicts]');
  assert.match(logPanel.textContent, /Save my note/);
  assert.equal((footPanel.textContent || '').includes('Save my note'), false);
  assert.equal(w.document.getElementById('jc-save-btn').style.display, 'none');
  const callsBefore = state.calls.length;
  state.patch = 'ok';
  [...w.document.querySelectorAll('button')].find(b => b.textContent === 'Save my note').click();
  await new Promise(r => setTimeout(r, 80));
  assert.ok(state.calls.length > callsBefore);
  const sent = state.rpc.at(-1).patches[0];
  assert.equal(sent.expected.updated_at, '2026-11-07T18:05:00.000Z');
  assert.equal(sent.patch.dayLogs[DAY].notes, 'my version');
  assert.equal(sent.patch.dayLogs[DAY].task, 'Second coat');
  assert.equal(sent.patch.dayLogs[DAY].startTime, '7:50 AM');
  assert.equal(ev('_jrLastSave.conflictProtected'), true);
  assert.equal(state.calls.some(u => u.includes('fp_crew_write_job_records')), false);
  assert.equal(statusText(), 'Saved 5:30 PM');
});

test('Use saved note waits to replace the box, and Not now leaves the typed note', async () => {
  state.patch = 'stale';
  openLog('old note');
  typeNote('my version');
  const box = notesBox();
  box.value = 'my version';
  state.settings.job_records = JSON.stringify([jobOf('their version', '2026-11-07T18:05:00.000Z')]);
  box.dispatchEvent(new w.Event('input', { bubbles: true }));
  w.document.querySelector('#jc-day-logs .jc-save-row .btn-primary').click();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(box.value, 'my version');
  [...w.document.querySelectorAll('button')].find(b => b.textContent === 'Not now').click();
  assert.equal(ev(`JOB_RECORDS[0].dayLogs['${DAY}'].notes`), 'my version');
  assert.equal(notesBox().value, 'my version');
  const panel = [...w.document.querySelectorAll('[data-jc-save-conflicts]')].map(el => el.textContent).join('');
  assert.equal(panel.includes('Saved note'), false);
  assert.equal(statusText(), 'Unsaved changes');
  w.document.querySelector('#jc-day-logs .jc-save-row .btn-primary').click();
  await new Promise(r => setTimeout(r, 80));
  state.patch = 'stale';
  const callsAtChoice = state.calls.length;
  [...w.document.querySelectorAll('button')].find(b => b.textContent === 'Use saved note').click();
  await new Promise(r => setTimeout(r, 80));
  assert.ok(state.calls.length > callsAtChoice);
  assert.equal(ev(`JOB_RECORDS[0].dayLogs['${DAY}'].notes`), 'my version');
  assert.equal(notesBox().value, 'my version');
  assert.match(statusText(), /hasn’t been saved/);
  state.patch = 'ok';
  [...w.document.querySelectorAll('button')].find(b => b.textContent === 'Use saved note').click();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(ev(`JOB_RECORDS[0].dayLogs['${DAY}'].notes`), 'their version');
  assert.equal(notesBox().value, 'their version');
  const sent = state.rpc.at(-1).patches[0];
  assert.equal(sent.patch.dayLogs[DAY].notes, 'their version');
  assert.match(statusText(), /Saved 5:30 PM|saved note is in the box/);
});

test('a failed save of my note leaves the typed note on screen', async () => {
  state.patch = 'stale';
  openLog('old note');
  typeNote('my version');
  state.settings.job_records = JSON.stringify([jobOf('their version', '2026-11-07T18:05:00.000Z')]);
  w.document.querySelector('#jc-day-logs .jc-save-row .btn-primary').click();
  await new Promise(r => setTimeout(r, 80));
  state.patch = 'down';
  [...w.document.querySelectorAll('button')].find(b => b.textContent === 'Save my note').click();
  await new Promise(r => setTimeout(r, 80));
  assert.equal(ev(`JOB_RECORDS[0].dayLogs['${DAY}'].notes`), 'my version');
  assert.equal(notesBox().value, 'my version');
  assert.match(statusText(), /hasn’t been saved/);
  assert.equal(statusText().includes('Saved 5:30'), false);
  assert.equal(w.document.body.textContent.includes('Save my note'), true);
});

test('an hours conflict does not offer to overwrite the clocks', async () => {
  state.patch = 'stale';
  openLog('old note');
  ev(`JOB_RECORDS[0].dayLogs['${DAY}'].endTime='4:00 PM'; _jrBaseline[0].dayLogs['${DAY}'].endTime='3:10 PM';`);
  const server = jobOf('old note', '2026-11-07T18:05:00.000Z');
  server.dayLogs[DAY].endTime = '3:40 PM';
  state.settings.job_records = JSON.stringify([server]);
  w.document.querySelector('#jc-day-logs .jc-save-row .btn-primary').click();
  await new Promise(r => setTimeout(r, 80));
  const shown = w.document.body.textContent;
  assert.match(shown, /hours/);
  assert.equal([...w.document.querySelectorAll('button')].some(b => b.textContent === 'Save my note'), false);
  assert.equal(ev(`JOB_RECORDS[0].dayLogs['${DAY}'].endTime`), '4:00 PM');
  [...w.document.querySelectorAll('button')].find(b => b.textContent === 'Not now').click();
  assert.equal(ev(`JOB_RECORDS[0].dayLogs['${DAY}'].endTime`), '4:00 PM');
});

test('typing in the notes box and clicking Save log uses that text', async () => {
  state.patch = 'ok';
  state.rpc.length = 0;
  openLog('old note');
  const box = notesBox();
  if (!box) throw new Error('notes box missing: ' + (w.document.getElementById('jc-day-logs')?.innerHTML || '').slice(0, 240));
  box.value = 'typed in the box';
  box.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(statusText(), 'Unsaved changes');
  assert.equal(ev(`JOB_RECORDS[0].dayLogs['${DAY}'].notes`), 'typed in the box');
  w.document.querySelector('#jc-day-logs .jc-save-row .btn-primary').click();
  await new Promise(r => setTimeout(r, 250));
  assert.equal(statusText(), 'Saved 5:30 PM');
  assert.equal(state.rpc[0].patches[0].patch.dayLogs[DAY].notes, 'typed in the box');
  assert.equal(ev(`JOB_RECORDS[0].dayLogs['${DAY}'].startTime`), '7:50 AM');
});

test('a missing conditional write keeps the draft and does not merge', async () => {
  state.patch = 'missing';
  state.calls.length = 0;
  state.writes.length = 0;
  openLog('old note');
  typeNote('keep me');
  const stored = state.settings.job_records;
  await call('saveJobCard');
  assert.match(statusText(), /Your note is still here/);
  assert.equal(ev(`JOB_RECORDS[0].dayLogs['${DAY}'].notes`), 'keep me');
  assert.equal(state.settings.job_records, stored);
  assert.equal(state.writes.length, 0);
  assert.equal(state.calls.some(u => u.includes('fp_crew_write_job_records')), false);
});

test('leaving with unsaved changes can be cancelled', async () => {
  openLog('old note');
  typeNote('still typing');
  w.confirm = () => false;
  call('showPage', 'jobs');
  assert.equal(w.document.getElementById('page-jobs').classList.contains('active'), false);
  assert.equal(w.document.getElementById('modal-jobcard').classList.contains('open'), true);
  w.confirm = () => true;
});

test('sign-out drops the open draft and does not keep it for the next person', async () => {
  state.patch = 'ok';
  openLog('old note');
  typeNote('private note');
  w.confirm = () => true;
  await call('pinLogout', { target: w.document.getElementById('sb-sign-out') });
  await call('pinLogout', { target: w.document.getElementById('sb-sign-out') });
  assert.equal(ev('JOB_RECORDS.length'), 0);
  assert.equal(w.document.getElementById('jc-customer').value, '');
  assert.equal(w.document.getElementById('login-screen').style.display, 'flex');
  assert.equal(w.localStorage.getItem('fpRole'), null);
});

test('a slow restore says Restoring session, and a network error is Retry rather than a logout', async () => {
  ev('loadAllFromSupabase=async function(){ return; }');
  state.whoami = 'slow';
  state.hold = null;
  w.localStorage.setItem('fpAuth_v2', JSON.stringify({
    refresh_token: 'refresh-office', access_token: 'access-office', expires_at: Date.now() + 3600000,
    kind: 'office', ts: Date.now(), display_name: 'Ops Reviewer', user_id: 'ops-1',
  }));
  const boot = call('fpBootAuth');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(w.document.getElementById('login-restore-msg').textContent, 'Restoring session');
  assert.equal(w.document.getElementById('pin-login-form').style.display, 'none');
  assert.equal(ev('_sessionAuthed'), false);
  state.hold();
  await boot;
  assert.equal(w.document.getElementById('login-screen').style.display, 'none');

  state.whoami = 'down';
  w.localStorage.setItem('fpAuth_v2', JSON.stringify({
    refresh_token: 'refresh-office', access_token: 'access-office', expires_at: Date.now() + 3600000,
    kind: 'office', ts: Date.now(), display_name: 'Ops Reviewer', user_id: 'ops-1',
  }));
  await call('fpBootAuth');
  assert.equal(w.document.getElementById('login-screen').style.display, 'flex');
  assert.match(w.document.getElementById('login-restore-msg').textContent, /Can't reach the server/);
  assert.equal(w.document.getElementById('login-restore-retry').style.display, 'inline-flex');
  assert.equal(ev('_sessionAuthed'), false);
  assert.ok(w.localStorage.getItem('fpAuth_v2'));
  assert.equal(w.document.getElementById('fp-test-banner').textContent.includes('floorpro-crm-test'), true);
  assert.equal(ev('SUPABASE_URL'), 'https://nndjnywtkgxwvxajwztg.supabase.co');
});

test('the test preview cannot address the live project', async () => {
  const { buildTestPreview } = await import('./build-test-preview.mjs');
  const built = buildTestPreview(html);
  assert.doesNotMatch(built, /const _fpLiveUrl/);
  assert.doesNotMatch(built, /const SUPABASE_URL = _fpUseTest/);
  assert.match(built, /const SUPABASE_URL = 'https:\/\/nndjnywtkgxwvxajwztg\.supabase\.co'/);
  assert.match(built, /Blocked live project from the test preview/);
  assert.match(built, /fpTestNnd:/);
  assert.match(built, /fpAuth_test_nndjnywtkgxwvxajwztg/);
  assert.match(built, /TEST PROJECT — floorpro-crm-test, not the live app/);
  const guard = built.slice(built.indexOf('Blocked live project') - 400, built.indexOf('Blocked live project') + 80);
  assert.match(guard, /cngbsmmdfxmerlqnkate/);
  const outside = built.replace(guard, '');
  assert.equal(outside.includes('cngbsmmdfxmerlqnkate'), false);
});
