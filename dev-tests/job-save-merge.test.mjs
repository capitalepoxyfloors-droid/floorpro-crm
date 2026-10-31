/**
 * A save of one job must not write the other jobs this page loaded earlier.
 * Mirrors the 2026-10-27 incident: notes on GBH went out with a stale Zimmerman
 * crew list and dropped Brendon's Oct 28–30 days. No live network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const ZIMM = '4636d90c-81d7-4c50-8e2a-3bfebbe0a635';
const GBH = 'gbh-phase-2';
const BRENDON_DAYS = ['2026-10-28', '2026-10-29', '2026-10-30'];

const state = {
  settings: {},
  slots: [],
  audit: [],
  failRpc: true,
  holdWrite: null,
};
const calls = [];
let releaseWrite = () => {};

function holdNextWrite() {
  state.holdWrite = new Promise(resolve => { releaseWrite = resolve; });
}

function applyPatches(jobs, patches) {
  const stamp = '2026-10-30T15:00:00.000Z';
  for (const p of patches || []) {
    const idx = jobs.findIndex(j => j.id === p.id);
    if (p.op === 'delete') {
      if (idx >= 0) jobs.splice(idx, 1);
      continue;
    }
    if (idx < 0) continue;
    Object.keys(p.patch || {}).forEach(k => { jobs[idx][k] = p.patch[k]; });
    (p.drop || []).forEach(k => { delete jobs[idx][k]; });
    jobs[idx].updated_at = stamp;
  }
  return jobs;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch(url, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const u = String(url);
  let body = null;
  if (opts.body && typeof opts.body === 'string') {
    try { body = JSON.parse(opts.body); } catch { body = opts.body; }
  }
  calls.push({ url: u, method, body });
  if (u.includes('/rest/v1/rpc/')) {
    if (state.failRpc) {
      return Promise.resolve(jsonResponse({ code: 'PGRST202', message: 'Could not find the function public.fp_patch_job_records(patches) in the schema cache' }, 404));
    }
    const jobs = applyPatches(JSON.parse(state.settings.job_records || '[]'), body && body.patches);
    state.settings.job_records = JSON.stringify(jobs);
    const finish = () => jsonResponse({ ok: true, jobs: JSON.parse(state.settings.job_records) });
    if (state.holdWrite) {
      const gate = state.holdWrite;
      state.holdWrite = null;
      return gate.then(finish);
    }
    return Promise.resolve(finish());
  }
  if (u.includes('/rest/v1/settings')) {
    if (method === 'GET') {
      const m = u.match(/key=eq\.([^&]+)/);
      const key = m ? decodeURIComponent(m[1]) : '';
      if (Object.prototype.hasOwnProperty.call(state.settings, key)) {
        return Promise.resolve(jsonResponse([{ key, value: state.settings[key] }]));
      }
      return Promise.resolve(jsonResponse([]));
    }
    if (method === 'POST' && body && body.key) {
      const finish = () => {
        state.settings[body.key] = body.value;
        return jsonResponse([body]);
      };
      if (state.holdWrite) {
        const gate = state.holdWrite;
        state.holdWrite = null;
        return gate.then(finish);
      }
      return Promise.resolve(finish());
    }
  }
  if (u.includes('/rest/v1/scheduled_slots') && method === 'GET') return Promise.resolve(jsonResponse(state.slots));
  if (u.includes('/rest/v1/scheduled_slots') && method === 'DELETE') {
    const m = u.match(/id=eq\.([^&]+)/);
    if (m) state.slots = state.slots.filter(s => String(s.id) !== decodeURIComponent(m[1]));
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  if (u.includes('/rest/v1/audit_log') && method === 'POST') {
    state.audit.push(body);
    return Promise.resolve(jsonResponse([{ id: state.audit.length }]));
  }
  if (method === 'GET') return Promise.resolve(jsonResponse([]));
  if (method === 'POST') return Promise.resolve(jsonResponse([{ id: 1 }]));
  return Promise.resolve(new Response(null, { status: 204 }));
}

function storedJobs() {
  return JSON.parse(state.settings.job_records);
}

function zimm(jobs) {
  return jobs.find(j => j.id === ZIMM);
}

let dom;
let w;
const lex = (name) => w.eval(name);
function setLex(name, value) {
  w.__fpTmp = value;
  w.eval(name + ' = window.__fpTmp');
}
const call = (name, ...args) => {
  w.__fpArgs = args;
  return w.eval(name + '.apply(undefined, window.__fpArgs)');
};
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function loadedPair() {
  return [
    { id: ZIMM, customer: 'Zimmerman', startDate: '2026-10-26', endDate: '2026-10-30', crewNames: 'Seth West', crewDays: { 'Seth West': ['2026-10-26', '2026-10-27'] }, status: 'scheduled', dayLogs: {} },
    { id: GBH, customer: 'GBH - Salvation Army - Phase 2', startDate: '2026-10-26', endDate: '2026-10-30', crewNames: 'Seth West', status: 'in_progress', dayLogs: { '2026-10-28': { notes: 'old note', task: '', materialsUsed: [], crewPresent: [] } } },
  ];
}

function serverWithBrendon(gbhNotes) {
  const jobs = loadedPair();
  jobs[0].crewNames = 'Seth West, Brendon Bennett';
  jobs[0].crewDays['Brendon Bennett'] = BRENDON_DAYS.slice();
  if (gbhNotes != null) jobs[1].dayLogs['2026-10-28'].notes = gbhNotes;
  return jobs;
}

function arm(localJobs, serverJobs) {
  state.slots = [];
  state.audit = [];
  state.failRpc = true;
  state.holdWrite = null;
  calls.length = 0;
  lex('JOB_RECORDS').splice(0, lex('JOB_RECORDS').length, ...JSON.parse(JSON.stringify(localJobs)));
  setLex('_jrBaseline', JSON.parse(JSON.stringify(localJobs)));
  state.settings.job_records = JSON.stringify(serverJobs);
  state.settings.slot_job_map = JSON.stringify({ '1_0_2': ZIMM, '1_0_3': ZIMM, '1_0_4': ZIMM });
  setLex('_jobRecordsLoadOk', true);
  setLex('_slotsLoadOk', true);
  setLex('_slotMapLoadOk', true);
  w.localStorage.removeItem('fpRole');
}

test.before(async () => {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/Could not parse CSS|css/i.test(msg)) return;
    throw err;
  });
  dom = new JSDOM(html, {
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
  w = dom.window;
  await new Promise(r => setTimeout(r, 30));
});
test.after(() => { if (w) w.close(); });

test('saving GBH notes keeps Brendon on Zimmerman', async () => {
  const local = loadedPair();
  arm(local, serverWithBrendon('old note'));
  const gbh = lex('JOB_RECORDS').find(j => j.id === GBH);
  gbh.dayLogs['2026-10-28'].notes = 'Day 3 note from the PM';
  const saved = await call('saveJobRecords', GBH);
  assert.equal(saved, true);
  const jobs = storedJobs();
  assert.deepEqual(zimm(jobs).crewDays['Brendon Bennett'], BRENDON_DAYS);
  assert.equal(zimm(jobs).crewNames, 'Seth West, Brendon Bennett');
  assert.equal(jobs.find(j => j.id === GBH).dayLogs['2026-10-28'].notes, 'Day 3 note from the PM');
  assert.deepEqual(plain(lex('JOB_RECORDS').find(j => j.id === ZIMM).crewDays['Brendon Bennett']), BRENDON_DAYS);
});

test('a dirty local copy of Zimmerman is not what gets written', async () => {
  arm(loadedPair(), serverWithBrendon('old note'));
  const z = lex('JOB_RECORDS').find(j => j.id === ZIMM);
  z.crewDays = { 'Seth West': ['2026-10-26'] };
  z.crewNames = 'Seth West';
  lex('JOB_RECORDS').find(j => j.id === GBH).dayLogs['2026-10-28'].notes = 'only this note';
  const saved = await call('saveJobRecords', GBH);
  assert.equal(saved, true);
  assert.deepEqual(zimm(storedJobs()).crewDays['Brendon Bennett'], BRENDON_DAYS);
  assert.equal(storedJobs().find(j => j.id === GBH).dayLogs['2026-10-28'].notes, 'only this note');
});

test('a stale edit of the same notes is refused and Zimmerman stays', async () => {
  arm(loadedPair(), serverWithBrendon('notes saved by someone else'));
  lex('JOB_RECORDS').find(j => j.id === GBH).dayLogs['2026-10-28'].notes = 'my newer note';
  const before = state.settings.job_records;
  const saved = await call('saveJobRecords', GBH);
  assert.equal(saved, false);
  assert.equal(state.settings.job_records, before);
  assert.equal(zimm(storedJobs()).crewDays['Brendon Bennett'][0], '2026-10-28');
  assert.match(w.document.getElementById('sync-status').textContent, /nothing was saved/i);
});

test('focus refresh picks up Brendon before the next save', async () => {
  arm(loadedPair(), serverWithBrendon('old note'));
  setLex('_sessionAuthed', true);
  setLex('_accessToken', 'access-office');
  setLex('_accessExp', Date.now() + 60 * 60 * 1000);
  w.document.getElementById('login-screen').style.display = 'none';
  lex('JOB_RECORDS').find(j => j.id === GBH).dayLogs['2026-10-28'].notes = 'typed before refresh';
  await call('fpRefreshSharedData');
  assert.deepEqual(plain(lex('JOB_RECORDS').find(j => j.id === ZIMM).crewDays['Brendon Bennett']), BRENDON_DAYS);
  assert.equal(lex('JOB_RECORDS').find(j => j.id === GBH).dayLogs['2026-10-28'].notes, 'typed before refresh');
  const saved = await call('saveJobRecords', GBH);
  assert.equal(saved, true);
  assert.deepEqual(zimm(storedJobs()).crewDays['Brendon Bennett'], BRENDON_DAYS);
  assert.equal(storedJobs().find(j => j.id === GBH).dayLogs['2026-10-28'].notes, 'typed before refresh');
});

test('slot cleanup re-reads and does not delete Brendon from a stale job list', async () => {
  const local = loadedPair();
  local[0].endDate = '2026-10-27';
  arm(local, serverWithBrendon('old note'));
  state.slots = BRENDON_DAYS.map((dt, i) => ({
    id: 501 + i,
    crew_idx: 1,
    week_offset: 0,
    day_idx: 2 + i,
    label: 'Zimmerman',
    job_type: 'epoxy:' + dt,
  }));
  const deletesBefore = calls.filter(c => c.method === 'DELETE').length;
  await call('deduplicateSlotsByJobRecord');
  assert.equal(state.slots.length, 3);
  assert.equal(calls.filter(c => c.method === 'DELETE').length, deletesBefore);
  const stale = { ...local[0] };
  await call('jcCleanOrphanedSlots', stale);
  assert.equal(state.slots.length, 3, 'fresh crewDays still has Brendon');
  assert.equal(state.audit.filter(a => String(a.details || '').includes('501')).length, 0);
});

function gbhNotes(jobs) {
  return jobs.find(j => j.id === GBH).dayLogs['2026-10-28'].notes;
}

async function waitUntil(fn) {
  for (let i = 0; i < 50; i++) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

test('typing a daily log note saves that job without Save Log', async () => {
  arm(loadedPair(), serverWithBrendon('old note'));
  setLex('_jcId', GBH);
  call('jcLogSet', '2026-10-28', 'notes', 'poured the primer');
  assert.equal(gbhNotes(lex('JOB_RECORDS')), 'poured the primer');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(gbhNotes(storedJobs()), 'old note');
  call('flushDayLogSave');
  await waitUntil(() => gbhNotes(storedJobs()) === 'poured the primer');
  assert.equal(gbhNotes(lex('JOB_RECORDS')), 'poured the primer');
  assert.deepEqual(zimm(storedJobs()).crewDays['Brendon Bennett'], BRENDON_DAYS);
  assert.equal(lex('_jcDayLogSaveTimer'), null);
});

test('a material quantity saves with the daily log', async () => {
  arm(loadedPair(), serverWithBrendon('old note'));
  setLex('_jcId', GBH);
  call('jcLogAddMat', '2026-10-28');
  call('jcLogSetMaterial', '2026-10-28', 0, 'name', 'Primer');
  call('jcLogSetMaterial', '2026-10-28', 0, 'qty', '2');
  call('flushDayLogSave');
  await waitUntil(() => {
    const mats = storedJobs().find(j => j.id === GBH).dayLogs['2026-10-28'].materialsUsed;
    return mats && mats[0] && mats[0].name === 'Primer' && String(mats[0].qty) === '2';
  });
  assert.deepEqual(zimm(storedJobs()).crewDays['Brendon Bennett'], BRENDON_DAYS);
});

test('keystrokes during a save stay and the next save stores them', async () => {
  arm(loadedPair(), serverWithBrendon('old note'));
  const gbh = lex('JOB_RECORDS').find(j => j.id === GBH);
  gbh.dayLogs['2026-10-28'].notes = 'ab';
  holdNextWrite();
  try {
    const first = call('saveJobRecords', GBH);
    await waitUntil(() => calls.some(c => c.method === 'POST' && c.url.includes('/rest/v1/settings')));
    gbh.dayLogs['2026-10-28'].notes = 'abc';
    releaseWrite();
    assert.equal(await first, true);
    assert.equal(gbh.dayLogs['2026-10-28'].notes, 'abc');
    assert.equal(gbhNotes(lex('_jrBaseline')), 'ab');
    assert.equal(gbhNotes(storedJobs()), 'ab');
    assert.deepEqual(zimm(storedJobs()).crewDays['Brendon Bennett'], BRENDON_DAYS);
    const second = await call('saveJobRecords', GBH);
    assert.equal(second, true);
    assert.equal(gbhNotes(storedJobs()), 'abc');
    assert.equal(gbh.dayLogs['2026-10-28'].notes, 'abc');
    assert.deepEqual(zimm(storedJobs()).crewDays['Brendon Bennett'], BRENDON_DAYS);
  } finally {
    releaseWrite();
    state.holdWrite = null;
  }
});

test('keystrokes during a patch save stay when the database function answers', async () => {
  arm(loadedPair(), serverWithBrendon('old note'));
  state.failRpc = false;
  const gbh = lex('JOB_RECORDS').find(j => j.id === GBH);
  gbh.dayLogs['2026-10-28'].notes = 'ab';
  holdNextWrite();
  try {
    const first = call('saveJobRecords', GBH);
    await waitUntil(() => calls.some(c => c.url.includes('/rest/v1/rpc/fp_patch_job_records')));
    gbh.dayLogs['2026-10-28'].notes = 'abc';
    releaseWrite();
    assert.equal(await first, true);
    assert.equal(gbh.dayLogs['2026-10-28'].notes, 'abc');
    assert.equal(gbhNotes(lex('_jrBaseline')), 'ab');
    assert.equal(gbhNotes(storedJobs()), 'ab');
    const second = await call('saveJobRecords', GBH);
    assert.equal(second, true);
    assert.equal(gbhNotes(storedJobs()), 'abc');
    assert.equal(gbh.dayLogs['2026-10-28'].notes, 'abc');
    assert.deepEqual(zimm(storedJobs()).crewDays['Brendon Bennett'], BRENDON_DAYS);
  } finally {
    releaseWrite();
    state.holdWrite = null;
    state.failRpc = true;
  }
});

test('slot cleanup deletes only when the fresh job agrees, and logs it', async () => {
  const server = serverWithBrendon('old note');
  server[0].endDate = '2026-10-27';
  delete server[0].crewDays['Brendon Bennett'];
  server[0].crewNames = 'Seth West';
  arm(loadedPair(), server);
  state.slots = [{ id: 501, crew_idx: 1, week_offset: 0, day_idx: 2, label: 'Zimmerman', job_type: 'epoxy:2026-10-28' }];
  await call('deduplicateSlotsByJobRecord');
  assert.equal(state.slots.length, 0);
  assert.ok(state.audit.some(a => String(a.details || '').includes('501')), 'the deleted slot id is in the audit log');
});
