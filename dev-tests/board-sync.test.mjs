/**
 * Jobs board stays in step with the schedule record.
 * In memory only — does not call the live or test Supabase project.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const state = {
  jobs: [],
  settings: {},
  audit: [],
  confirms: [],
};
const consoleErrors = [];

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function settingsKey(url) {
  const q = String(url).split('?')[1] || '';
  const m = q.match(/(?:^|&)key=eq\.([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function jobIdFromUrl(url) {
  const m = String(url).match(/[?&]id=eq\.([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function mockFetch(url, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const u = String(url);
  let body = null;
  if (opts.body && typeof opts.body === 'string') {
    try { body = JSON.parse(opts.body); } catch { body = opts.body; }
  }
  if (u.includes('/rest/v1/rpc/')) {
    return Promise.resolve(jsonResponse({ message: 'Could not find the function' }, 404));
  }
  if (u.includes('/rest/v1/audit_log') && method === 'POST') {
    state.audit.push(body);
    return Promise.resolve(new Response('', { status: 201 }));
  }
  if (u.includes('/rest/v1/settings')) {
    if (method === 'GET') {
      const key = settingsKey(u);
      if (key && Object.prototype.hasOwnProperty.call(state.settings, key)) {
        return Promise.resolve(jsonResponse([{ key, value: state.settings[key] }]));
      }
      return Promise.resolve(jsonResponse([]));
    }
    if (method === 'POST' && body && body.key) {
      state.settings[body.key] = body.value;
      return Promise.resolve(jsonResponse([body]));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  if (u.includes('/rest/v1/jobs')) {
    if (method === 'GET') return Promise.resolve(jsonResponse(state.jobs.slice()));
    if (method === 'PATCH') {
      const id = jobIdFromUrl(u);
      const row = state.jobs.find(r => String(r.id) === String(id));
      if (!row) return Promise.resolve(jsonResponse({ message: 'missing' }, 404));
      Object.assign(row, body);
      return Promise.resolve(jsonResponse([row]));
    }
    if (method === 'DELETE') {
      const id = jobIdFromUrl(u);
      const before = state.jobs.length;
      state.jobs = state.jobs.filter(r => String(r.id) !== String(id));
      if (state.jobs.length === before) return Promise.resolve(jsonResponse({ message: 'missing' }, 404));
      return Promise.resolve(new Response(null, { status: 204 }));
    }
  }
  if (method === 'GET') return Promise.resolve(jsonResponse([]));
  if (method === 'POST') return Promise.resolve(jsonResponse([{ id: 'posted' }]));
  return Promise.resolve(new Response(null, { status: 204 }));
}

let dom;
let w;

function lex(name) {
  return w.eval(name);
}
function call(name, ...args) {
  w.__fpArgs = args;
  return w.eval(name + '.apply(undefined, window.__fpArgs)');
}

function reset() {
  state.jobs = [];
  state.settings = { job_records: '[]', slot_job_map: '{}' };
  state.audit = [];
  state.confirms = [];
  w.localStorage.clear();
  w.localStorage.setItem('fpRole', 'admin');
  w.eval(`
    JOB_RECORDS.splice(0, JOB_RECORDS.length);
    _lastJobRows.splice(0, _lastJobRows.length);
    for (const k of Object.keys(SLOT_JOB_MAP)) delete SLOT_JOB_MAP[k];
    for (const k of Object.keys(multiSlots)) delete multiSlots[k];
    _jrBaseline = [];
    _jobRecordsLoadOk = true;
    _jcId = null;
  `);
}

function rememberRecords() {
  w.eval('_jrBaseline = JSON.parse(JSON.stringify(JOB_RECORDS))');
  state.settings.job_records = JSON.stringify(lex('JOB_RECORDS'));
}

function putRecord(job) {
  w.__fpJob = job;
  w.eval('JOB_RECORDS.push(window.__fpJob)');
  return job;
}

function putCard(row) {
  state.jobs.push(row);
  w.__fpRow = row;
  w.eval('_lastJobRows.push(window.__fpRow)');
  return row;
}

function audits(action, entity) {
  return state.audit.filter(a => a.action === action && (!entity || a.entity === entity));
}

test.before(async () => {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/Could not parse CSS|css/i.test(msg)) return;
    consoleErrors.push(msg);
  });
  virtualConsole.on('error', (...args) => {
    consoleErrors.push(args.map(a => (a && a.stack) ? a.stack : String(a)).join(' '));
  });
  dom = new JSDOM(html, {
    url: 'http://127.0.0.1/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = mockFetch;
      window.AbortController = AbortController;
      window.confirm = (msg) => { state.confirms.push(String(msg)); return true; };
      window.CSS = window.CSS || { escape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); } };
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    },
  });
  w = dom.window;
  await new Promise(r => setTimeout(r, 50));
});

test.after(() => {
  if (w) w.close();
});

test('deleting a schedule job removes its Jobs board card', async () => {
  reset();
  const rec = putRecord({ id: 'zz-del', customer: 'ZZ Board Sync Delete', value: '1500', status: 'in_progress', startDate: '2026-10-01', endDate: '2026-10-02', boardRowId: 'card-del', dayLogs: {} });
  putCard({ id: 'card-del', customer: 'ZZ Board Sync Delete', value: '1500', status: 'inprogress', detail: '', notes: '', display_val: '$1,500.00' });
  rememberRecords();
  w.eval('_jcId = "zz-del"');
  await call('deleteJobRecord');
  assert.equal(state.jobs.find(r => r.id === 'card-del'), undefined);
  assert.equal(lex('JOB_RECORDS').find(j => j.id === 'zz-del'), undefined);
  assert.ok(state.confirms[0].includes('Jobs board card will be removed'));
  assert.equal(audits('board_job_deleted', 'ZZ Board Sync Delete').length, 1);
  assert.equal(audits('job_deleted', 'ZZ Board Sync Delete').length, 1);
  assert.equal(rec.status, 'in_progress');
});

test('deleting a job leaves an invoiced card and flags it', async () => {
  reset();
  putRecord({ id: 'zz-inv', customer: 'ZZ Board Sync Invoiced', value: '8800', status: 'in_progress', startDate: '2026-09-01', endDate: '2026-09-03', boardRowId: 'card-inv', dayLogs: {} });
  putCard({ id: 'card-inv', customer: 'ZZ Board Sync Invoiced', value: '', status: 'invoiced', detail: 'Invoiced 9/4/26', notes: '', display_val: '—' });
  rememberRecords();
  w.eval('_jcId = "zz-inv"');
  await call('deleteJobRecord');
  const card = state.jobs.find(r => r.id === 'card-inv');
  assert.equal(card.status, 'invoiced');
  assert.match(card.detail, /Schedule record removed/);
  assert.match(card.notes, /Schedule record removed/);
  assert.equal(card.value, '');
  assert.equal(audits('board_job_deleted').length, 0);
  assert.equal(audits('board_job_updated', 'ZZ Board Sync Invoiced').length, 1);
  assert.match(audits('board_job_updated', 'ZZ Board Sync Invoiced')[0].details, /invoiced card kept and flagged/);
  assert.ok(state.confirms[0].includes('already invoiced'));
  await call('loadJobs');
  const host = w.document.getElementById('jobs-col-invoiced');
  assert.match(host.textContent, /Schedule removed/);
  assert.match(host.textContent, /Invoiced/);
  assert.match(host.textContent, /Undo/);
});

test('a paid card is flagged and its status is not changed', async () => {
  reset();
  putRecord({ id: 'zz-paid', customer: 'ZZ Board Sync Paid', value: '4200', status: 'complete', startDate: '2026-08-01', endDate: '2026-08-02', boardRowId: 'card-paid', dayLogs: {} });
  putCard({ id: 'card-paid', customer: 'ZZ Board Sync Paid', value: '4200', status: 'paid', detail: '', notes: '', display_val: '$4,200.00' });
  rememberRecords();
  w.eval('_jcId = "zz-paid"');
  await call('deleteJobRecord');
  const card = state.jobs.find(r => r.id === 'card-paid');
  assert.equal(card.status, 'paid');
  assert.match(card.detail, /review this paid card/);
  assert.equal(audits('board_job_deleted').length, 0);
  assert.equal(audits('board_status_changed').length, 0);
  await call('loadJobs');
  const host = w.document.getElementById('jobs-col-invoiced');
  assert.match(host.textContent, /Paid/);
  assert.match(host.textContent, /Schedule removed/);
  assert.doesNotMatch(host.textContent, /Undo/);
});

test('an invoiced card with no saved link is still flagged, not removed', async () => {
  reset();
  putRecord({ id: 'zz-inv2', customer: 'ZZ Board Sync Invoice Only', value: '100', status: 'in_progress', startDate: '2026-08-01', endDate: '2026-08-01', dayLogs: {} });
  putCard({ id: 'card-inv2', customer: 'ZZ Board Sync Invoice Only', value: '100', status: 'invoiced', detail: '', notes: '' });
  rememberRecords();
  w.eval('_jcId = "zz-inv2"');
  await call('deleteJobRecord');
  assert.equal(state.jobs[0].status, 'invoiced');
  assert.match(state.jobs[0].notes, /Schedule record removed/);
});

test('an unsure name match asks, and does not remove a card', async () => {
  reset();
  putRecord({ id: 'zz-amb', customer: 'ZZ Board Sync Twin', value: '100', status: 'in_progress', startDate: '2026-10-01', endDate: '2026-10-01', dayLogs: {} });
  putRecord({ id: 'zz-amb-other', customer: 'ZZ Board Sync Twin', value: '200', status: 'complete', startDate: '2026-07-01', endDate: '2026-07-02', dayLogs: {} });
  putCard({ id: 'card-other', customer: 'ZZ Board Sync Twin', value: '200', status: 'complete', detail: '', notes: '' });
  rememberRecords();
  w.eval('_jcId = "zz-amb"');
  await call('deleteJobRecord');
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].id, 'card-other');
  assert.equal(state.jobs[0].status, 'complete');
  assert.match(state.confirms[0], /sure match/);
  assert.match(state.confirms[0], /board will be left as it is/);
});

test('canceling the delete leaves the schedule job and the card', async () => {
  reset();
  w.confirm = (msg) => { state.confirms.push(String(msg)); return false; };
  putRecord({ id: 'zz-keep', customer: 'ZZ Board Sync Keep', value: '10', status: 'in_progress', startDate: '2026-10-01', endDate: '2026-10-01', boardRowId: 'card-keep', dayLogs: {} });
  putCard({ id: 'card-keep', customer: 'ZZ Board Sync Keep', value: '10', status: 'inprogress', detail: '', notes: '' });
  rememberRecords();
  w.eval('_jcId = "zz-keep"');
  await call('deleteJobRecord');
  assert.equal(lex('JOB_RECORDS').length, 1);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.audit.length, 0);
});

test('owner catch-up marks a crew-completed card complete, and a second run writes nothing', async () => {
  reset();
  putRecord({ id: 'zz-done', customer: 'ZZ Board Sync Crew Done', value: '3000', status: 'complete', startDate: '2026-10-06', endDate: '2026-10-08', boardRowId: 'card-done', dayLogs: { '2026-10-08': { task: 'done' } } });
  putCard({ id: 'card-done', customer: 'ZZ Board Sync Crew Done', value: '3000', status: 'inprogress', detail: '', notes: '' });
  putRecord({ id: 'zz-paid-stay', customer: 'ZZ Board Sync Paid Stay', value: '9999', status: 'complete', startDate: '2026-09-01', endDate: '2026-09-02', boardRowId: 'card-paid-stay', dayLogs: {} });
  putCard({ id: 'card-paid-stay', customer: 'ZZ Board Sync Paid Stay', value: '9999', status: 'paid', detail: '', notes: '' });
  putRecord({ id: 'zz-inv-stay', customer: 'ZZ Board Sync Invoiced Stay', value: '111', status: 'complete', startDate: '2026-09-01', endDate: '2026-09-02', boardRowId: 'card-inv-stay', dayLogs: {} });
  putCard({ id: 'card-inv-stay', customer: 'ZZ Board Sync Invoiced Stay', value: '111', status: 'invoiced', detail: 'Invoiced 9/3/26', notes: '' });
  putRecord({ id: 'zz-already', customer: 'ZZ Board Sync Already', value: '50', status: 'complete', startDate: '2026-09-01', endDate: '2026-09-01', boardRowId: 'card-already', dayLogs: {} });
  putCard({ id: 'card-already', customer: 'ZZ Board Sync Already', value: '50', status: 'complete', detail: '', notes: '' });
  rememberRecords();
  await call('catchUpCompletedBoardCards');
  assert.equal(state.jobs.find(r => r.id === 'card-done').status, 'complete');
  assert.equal(state.jobs.find(r => r.id === 'card-paid-stay').status, 'paid');
  assert.equal(state.jobs.find(r => r.id === 'card-inv-stay').status, 'invoiced');
  assert.equal(state.jobs.find(r => r.id === 'card-already').status, 'complete');
  const moved = audits('board_status_changed');
  assert.equal(moved.length, 1);
  assert.equal(moved[0].entity, 'ZZ Board Sync Crew Done');
  assert.match(moved[0].details, /inprogress → complete/);
  assert.equal(moved[0].actor, 'Manager');
  const patches = state.jobs.filter(r => r.status === 'complete').map(r => r.id).sort();
  assert.deepEqual(patches, ['card-already', 'card-done']);
  const auditCount = state.audit.length;
  const jobSnapshot = JSON.stringify(state.jobs);
  await call('catchUpCompletedBoardCards');
  assert.equal(state.audit.length, auditCount);
  assert.equal(JSON.stringify(state.jobs), jobSnapshot);
});

test('a crew session does not move the board card', async () => {
  reset();
  w.localStorage.setItem('fpRole', 'crew');
  putRecord({ id: 'zz-crew', customer: 'ZZ Board Sync Crew Session', value: '3000', status: 'complete', startDate: '2026-10-06', endDate: '2026-10-08', boardRowId: 'card-crew', dayLogs: {} });
  putCard({ id: 'card-crew', customer: 'ZZ Board Sync Crew Session', value: '3000', status: 'inprogress', detail: '', notes: '' });
  rememberRecords();
  await call('catchUpCompletedBoardCards');
  assert.equal(state.jobs[0].status, 'inprogress');
  assert.equal(state.audit.length, 0);
  assert.equal(lex('staleInProgressJobs')().length, 0);
});

test('an office session catch-up logs the office name and does not show a price', async () => {
  reset();
  w.localStorage.setItem('fpRole', 'admin');
  w.localStorage.setItem('fpOfficeUser', 'Pat Office');
  putRecord({ id: 'zz-office', customer: 'ZZ Board Sync Office', value: '424242', status: 'complete', startDate: '2026-10-01', endDate: '2026-10-02', boardRowId: 'card-office', dayLogs: {} });
  putCard({ id: 'card-office', customer: 'ZZ Board Sync Office', value: '424242', status: 'scheduled', detail: '', notes: '' });
  rememberRecords();
  await call('catchUpCompletedBoardCards');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(audits('board_status_changed')[0].actor, 'Pat Office');
  const toast = [...w.document.body.querySelectorAll('div')].map(el => el.textContent).find(t => t && t.includes('Jobs board caught up'));
  assert.ok(toast);
  assert.doesNotMatch(toast, /424242|\$/);
});

test('a name match without a saved link still completes the card', async () => {
  reset();
  putRecord({ id: 'zz-link', customer: 'ZZ Board Sync Unlinked', value: '640', status: 'complete', startDate: '2026-10-01', endDate: '2026-10-03', dayLogs: {} });
  putCard({ id: 'card-link', customer: 'ZZ Board Sync Unlinked', value: '640', status: 'inprogress', detail: '', notes: '' });
  rememberRecords();
  await call('catchUpCompletedBoardCards');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(lex('JOB_RECORDS')[0].boardRowId, 'card-link');
});

test('the stale notice lists only in-progress jobs whose last log is 3 or more days after the end date', async () => {
  reset();
  putRecord({
    id: 'zz-stale', customer: 'ZZ Board Sync Stale', value: '424242', status: 'in_progress',
    startDate: '2026-10-01', endDate: '2026-10-02',
    dayLogs: { '2026-10-02': { task: 'coat' }, '2026-10-07': { task: 'still here' } },
  });
  putRecord({
    id: 'zz-fresh', customer: 'ZZ Board Sync Fresh', value: '10', status: 'in_progress',
    startDate: '2026-10-01', endDate: '2026-10-08',
    dayLogs: { '2026-10-10': { task: 'two days over' } },
  });
  putRecord({
    id: 'zz-nolog', customer: 'ZZ Board Sync No Log', value: '10', status: 'in_progress',
    startDate: '2026-09-01', endDate: '2026-09-02', dayLogs: {},
  });
  putRecord({
    id: 'zz-finished', customer: 'ZZ Board Sync Finished Late', value: '10', status: 'complete',
    startDate: '2026-09-01', endDate: '2026-09-02',
    dayLogs: { '2026-09-20': { task: 'late but done' } },
  });
  rememberRecords();
  const listed = Array.from(lex('staleInProgressJobs')(), item => String(item.job.customer));
  assert.deepEqual(listed, ['ZZ Board Sync Stale']);
  call('renderStaleJobNotice');
  const dash = w.document.getElementById('dash-stale-notice').textContent;
  const jobs = w.document.getElementById('jobs-stale-notice').textContent;
  assert.match(dash, /ZZ Board Sync Stale/);
  assert.match(dash, /5 days after/);
  assert.equal(dash, jobs);
  assert.doesNotMatch(dash, /424242|\$|Fresh|No Log|Finished/);
  w.localStorage.setItem('fpRole', 'crew');
  call('renderStaleJobNotice');
  assert.equal(w.document.getElementById('dash-stale-notice').textContent, '');
  assert.equal(w.document.getElementById('jobs-stale-notice').style.display, 'none');
});

test('syncBoardCardStatus does not pull a paid or invoiced card backward', async () => {
  reset();
  const paid = putRecord({ id: 'zz-sync-paid', customer: 'ZZ Board Sync Sync Paid', value: '80', status: 'in_progress', boardRowId: 'card-sync-paid', dayLogs: {} });
  putCard({ id: 'card-sync-paid', customer: 'ZZ Board Sync Sync Paid', value: '80', status: 'paid', detail: '', notes: '' });
  const inv = putRecord({ id: 'zz-sync-inv', customer: 'ZZ Board Sync Sync Inv', value: '80', status: 'in_progress', boardRowId: 'card-sync-inv', dayLogs: {} });
  putCard({ id: 'card-sync-inv', customer: 'ZZ Board Sync Sync Inv', value: '80', status: 'invoiced', detail: '', notes: '' });
  rememberRecords();
  await call('syncBoardCardStatus', paid, 'complete');
  await call('syncBoardCardStatus', inv, 'scheduled');
  assert.equal(state.jobs.find(r => r.id === 'card-sync-paid').status, 'paid');
  assert.equal(state.jobs.find(r => r.id === 'card-sync-inv').status, 'invoiced');
  assert.equal(state.audit.length, 0);
});

test.after(() => {
  if (consoleErrors.length) {
    // Surface unexpected page errors without failing on CSS noise already filtered above.
    consoleErrors.forEach(msg => console.error(msg));
  }
});
