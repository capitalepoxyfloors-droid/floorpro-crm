/**
 * Save Log must not die just because some other field on the job changed.
 * The patch RPC is mocked. Nothing here talks to a database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const JOB = 'job-maple';
const DAY = '2026-11-12';
const LOADED_STAMP = '2026-11-13T12:00:00.000Z';
const SERVER_STAMP = '2026-11-13T15:04:00.000Z';
const NOTE = 'Poured the east bay. Needs another coat tomorrow.';

const state = {
  mode: 'ok', // ok | safe | overlap | network
  jobs: [],
  patchCalls: [],
};
const calls = [];

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function stampOf(v) {
  return v === undefined || v === null ? '' : String(v);
}
function mockFetch(url, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const u = String(url);
  let body = null;
  if (opts.body && typeof opts.body === 'string') {
    try { body = JSON.parse(opts.body); } catch { body = opts.body; }
  }
  calls.push({ url: u, method, body });
  if (u.includes('/rest/v1/rpc/fp_patch_job_records')) {
    const patches = (body && body.patches) || [];
    state.patchCalls.push(JSON.parse(JSON.stringify(patches)));
    if (state.mode === 'network') return Promise.reject(new TypeError('Failed to fetch'));
    for (const p of patches) {
      const job = state.jobs.find(j => String(j.id) === String(p.id));
      if (!job) return Promise.resolve(jsonResponse({ code: 'P0001', message: 'stale_job' }, 400));
      const exp = p.expected || {};
      if (stampOf(job.updated_at) !== stampOf(exp.updated_at)) {
        return Promise.resolve(jsonResponse({ code: 'P0001', message: 'stale_job', details: 'updated_at' }, 400));
      }
      const keys = new Set([...Object.keys(p.patch || {}), ...(p.drop || [])]);
      for (const k of keys) {
        if (k === 'id' || k === 'updated_at') continue;
        const serverVal = Object.prototype.hasOwnProperty.call(job, k) ? job[k] : null;
        const expVal = Object.prototype.hasOwnProperty.call(exp, k) ? exp[k] : null;
        if (!w._jrEqCanon(serverVal, expVal)) {
          return Promise.resolve(jsonResponse({ code: 'P0001', message: 'stale_job', details: k }, 400));
        }
      }
    }
    const nextStamp = '2026-11-13T15:09:00.00' + state.patchCalls.length + 'Z';
    for (const p of patches) {
      const job = state.jobs.find(j => String(j.id) === String(p.id));
      Object.keys(p.patch || {}).forEach(k => {
        if (k === 'id' || k === 'updated_at') return;
        job[k] = JSON.parse(JSON.stringify(p.patch[k]));
      });
      (p.drop || []).forEach(k => { if (k !== 'id' && k !== 'updated_at') delete job[k]; });
      job.updated_at = nextStamp;
    }
    return Promise.resolve(jsonResponse({ ok: true, jobs: JSON.parse(JSON.stringify(state.jobs)) }));
  }
  if (u.includes('/rest/v1/rpc/')) return Promise.resolve(jsonResponse({ ok: true }));
  if (u.includes('/rest/v1/settings') && method === 'GET') {
    const m = u.match(/key=eq\.([^&]+)/);
    const key = m ? decodeURIComponent(m[1]) : '';
    if (key === 'job_records') return Promise.resolve(jsonResponse([{ key, value: JSON.stringify(state.jobs) }]));
    return Promise.resolve(jsonResponse([]));
  }
  if (u.includes('/rest/v1/settings') && method === 'POST' && body && body.key === 'job_records') {
    state.jobs = JSON.parse(body.value);
    return Promise.resolve(jsonResponse([body]));
  }
  if (u.includes('/rest/v1/audit_log') && method === 'POST') return Promise.resolve(jsonResponse([{ id: 1 }]));
  if (method === 'GET') return Promise.resolve(jsonResponse([]));
  if (method === 'POST') return Promise.resolve(jsonResponse([{ id: 1 }]));
  return Promise.resolve(new Response(null, { status: 204 }));
}

function baseJob(extra) {
  return Object.assign({
    id: JOB,
    customer: 'Maple Shop',
    phone: '',
    address: '',
    scope: '',
    jobType: 'epoxy',
    value: '',
    status: 'in_progress',
    startDate: DAY,
    endDate: DAY,
    crewNames: '',
    crewDays: { 'Seth West': [DAY] },
    dayLogs: { [DAY]: { notes: '', task: '', materialsUsed: [], crewPresent: [], startTime: '', endTime: '' } },
    updated_at: LOADED_STAMP,
  }, extra || {});
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

function arm(serverJob, localJob) {
  state.patchCalls = [];
  calls.length = 0;
  state.jobs = [JSON.parse(JSON.stringify(serverJob))];
  const local = JSON.parse(JSON.stringify(localJob || baseJob()));
  lex('JOB_RECORDS').splice(0, lex('JOB_RECORDS').length, JSON.parse(JSON.stringify(local)));
  setLex('_jrBaseline', [JSON.parse(JSON.stringify(local))]);
  setLex('_jcUserEdited', false);
  setLex('_jcSaveIssue', null);
  setLex('_jcId', null);
  w.localStorage.removeItem('fpRole');
  const type = w.document.getElementById('jc-jobtype');
  type.innerHTML = '<option value="epoxy">Epoxy</option>';
  const oldAlert = w.document.getElementById('save-alert');
  if (oldAlert) oldAlert.remove();
  const oldBadge = w.document.getElementById('save-badge');
  if (oldBadge) oldBadge.remove();
}

function openLog() {
  call('openJobCard', JOB);
  call('jcTab', 'log');
  const box = [...w.document.querySelectorAll('#jc-day-logs textarea')]
    .find(el => (el.getAttribute('placeholder') || '').includes('Anything worth noting'));
  assert.ok(box, 'notes field is on the log');
  return box;
}
function typeNote(box, text) {
  box.value = text;
  box.dispatchEvent(new w.Event('input', { bubbles: true }));
}
function patchBodies() {
  return state.patchCalls;
}
function screenText() {
  const ids = ['save-alert', 'jc-save-banner', 'jc-unsaved-pill', 'save-badge'];
  return ids.map(id => {
    const el = w.document.getElementById(id);
    return el ? el.textContent : '';
  }).join('\n');
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

test('typing a note marks the card Unsaved', () => {
  state.mode = 'ok';
  arm(baseJob());
  const box = openLog();
  const pill = w.document.getElementById('jc-unsaved-pill');
  assert.equal(pill.style.display, 'none');
  typeNote(box, NOTE);
  assert.equal(pill.style.display, 'inline-flex');
  assert.equal(pill.textContent.trim(), 'Unsaved');
  assert.equal(lex('JOB_RECORDS')[0].dayLogs[DAY].notes, NOTE);
});

test('a stale clash on a different field saves once and shows Saved', async () => {
  state.mode = 'safe';
  const server = baseJob({
    updated_at: SERVER_STAMP,
    crewDays: { 'Seth West': [DAY], 'Brendon Bennett': [DAY] },
    crewNames: 'Seth West, Brendon Bennett',
  });
  arm(server);
  const box = openLog();
  typeNote(box, NOTE);
  const saved = await call('saveJobCard');
  assert.equal(saved, undefined);
  assert.equal(patchBodies().length, 2, 'one automatic retry');
  assert.equal(stampOf(patchBodies()[0][0].expected.updated_at), LOADED_STAMP);
  assert.equal(stampOf(patchBodies()[1][0].expected.updated_at), SERVER_STAMP);
  assert.notEqual(stampOf(patchBodies()[1][0].expected.updated_at), LOADED_STAMP);
  const stored = state.jobs.find(j => j.id === JOB);
  assert.equal(stored.dayLogs[DAY].notes, NOTE);
  assert.deepEqual(stored.crewDays['Brendon Bennett'], [DAY]);
  assert.equal(lex('JOB_RECORDS')[0].dayLogs[DAY].notes, NOTE);
  assert.deepEqual(JSON.parse(JSON.stringify(lex('JOB_RECORDS')[0].crewDays['Brendon Bennett'])), [DAY]);
  const badge = w.document.getElementById('save-badge');
  assert.ok(badge);
  assert.match(badge.textContent, /Saved/);
  assert.equal(w.document.getElementById('save-alert'), null);
  assert.equal(w.document.getElementById('jc-save-banner'), null);
  assert.equal(w.document.getElementById('jc-unsaved-pill').style.display, 'none');
  assert.equal(w.document.getElementById('modal-jobcard').classList.contains('open'), false);
  assert.doesNotMatch(screenText(), /stale_job|P0001|updated_at/);
});

test('an overlapping dayLogs change stays unsaved with the note still in the field', async () => {
  state.mode = 'overlap';
  const server = baseJob({
    updated_at: SERVER_STAMP,
    dayLogs: { [DAY]: { notes: 'Office already wrote a different note', task: '', materialsUsed: [], crewPresent: [], startTime: '', endTime: '' } },
  });
  arm(server);
  const box = openLog();
  typeNote(box, NOTE);
  await call('saveJobCard');
  assert.equal(patchBodies().length, 1, 'does not retry over a real overlap');
  assert.equal(stampOf(patchBodies()[0][0].expected.updated_at), LOADED_STAMP);
  assert.equal(state.jobs[0].dayLogs[DAY].notes, 'Office already wrote a different note');
  assert.equal(box.value, NOTE);
  assert.equal(lex('JOB_RECORDS')[0].dayLogs[DAY].notes, NOTE);
  const alert = w.document.getElementById('save-alert');
  const banner = w.document.getElementById('jc-save-banner');
  assert.ok(alert);
  assert.ok(banner);
  assert.match(banner.textContent, /Not saved\. This job was just changed by someone else\. Copy your note, tap Reload, then save again\./);
  assert.match(alert.textContent, /Not saved\. This job was just changed by someone else\. Copy your note, tap Reload, then save again\./);
  const reload = banner.querySelector('button');
  assert.equal(reload.textContent.trim(), 'Reload');
  assert.ok(parseFloat(w.getComputedStyle(reload).minHeight) >= 44);
  assert.equal(w.document.getElementById('jc-unsaved-pill').style.display, 'inline-flex');
  assert.equal(w.document.getElementById('modal-jobcard').classList.contains('open'), true);
  assert.equal(w.document.getElementById('save-badge'), null);
  assert.doesNotMatch(alert.textContent + banner.textContent, /stale_job|P0001|updated_at/);
  alert.querySelector('button').click();
  assert.equal(w.document.getElementById('save-alert'), null);
  assert.ok(w.document.getElementById('jc-save-banner'), 'the card banner stays after the popup is tapped away');
  assert.equal(box.value, NOTE);

  await call('jcReloadOpenJob');
  const boxAfter = [...w.document.querySelectorAll('#jc-day-logs textarea')]
    .find(el => (el.getAttribute('placeholder') || '').includes('Anything worth noting'));
  assert.equal(boxAfter.value, NOTE);
  assert.equal(lex('_jrBaseline')[0].updated_at, SERVER_STAMP);
  assert.equal(lex('_jrBaseline')[0].dayLogs[DAY].notes, 'Office already wrote a different note');
  assert.equal(w.document.getElementById('jc-save-banner'), null);
  assert.equal(w.document.getElementById('jc-unsaved-pill').style.display, 'inline-flex');
  assert.match([...w.document.querySelectorAll('body > div')].map(el => el.textContent).join('\n'), /Tap Save again/);

  state.patchCalls = [];
  await call('saveJobCard');
  assert.equal(patchBodies().length, 1);
  assert.equal(stampOf(patchBodies()[0][0].expected.updated_at), SERVER_STAMP);
  assert.equal(state.jobs[0].dayLogs[DAY].notes, NOTE);
  assert.match(w.document.getElementById('save-badge').textContent, /Saved/);
  assert.equal(w.document.getElementById('jc-unsaved-pill').style.display, 'none');
});

test('a network failure tells them to tap Save again and keeps the note', async () => {
  state.mode = 'network';
  arm(baseJob());
  const box = openLog();
  typeNote(box, NOTE);
  await call('saveJobCard');
  assert.equal(patchBodies().length, 1);
  assert.equal(box.value, NOTE);
  assert.equal(lex('JOB_RECORDS')[0].dayLogs[DAY].notes, NOTE);
  assert.equal(lex('_jrBaseline')[0].updated_at, LOADED_STAMP);
  const alert = w.document.getElementById('save-alert');
  const banner = w.document.getElementById('jc-save-banner');
  assert.ok(alert);
  assert.ok(banner);
  assert.match(alert.textContent, /Not saved\. Check your signal and tap Save again\./);
  assert.match(banner.textContent, /Not saved\. Check your signal and tap Save again\./);
  assert.equal(banner.querySelector('button'), null);
  assert.equal(w.document.getElementById('jc-unsaved-pill').style.display, 'inline-flex');
  assert.equal(w.document.getElementById('modal-jobcard').classList.contains('open'), true);
  assert.equal(w.document.getElementById('save-badge'), null);
  assert.doesNotMatch(alert.textContent + banner.textContent, /stale_job|P0001|Failed to fetch|TypeError/);
  alert.querySelector('button').click();
  assert.equal(w.document.getElementById('save-alert'), null);
  assert.ok(w.document.getElementById('jc-save-banner'));
  assert.equal(box.value, NOTE);
});

function localISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function notesBox(ds) {
  const sec = w.document.getElementById('jcday-' + ds.replace(/-/g, ''));
  assert.ok(sec, 'day section ' + ds);
  const box = [...sec.querySelectorAll('textarea')].find(el => (el.getAttribute('placeholder') || '').includes('Anything worth noting'));
  assert.ok(box, 'notes on ' + ds);
  return box;
}
function pillOn() {
  return w.document.getElementById('jc-unsaved-pill').style.display === 'inline-flex';
}
function spanDays() {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const future = new Date(today);
  do { future.setDate(future.getDate() + 1); } while (future.getDay() !== 1);
  return { today: localISO(today), future: localISO(future) };
}
// Save blurs the notes field. That blur used to mark the card unsaved again
// even when the text was already stored, including after the card was reopened.
async function saveNoteAndLeaveIt(ds, text) {
  call('openJobCard', JOB);
  call('jcTab', 'log');
  const box = notesBox(ds);
  typeNote(box, text);
  assert.equal(pillOn(), true, 'typing marks Unsaved');
  await call('saveJobCard');
  assert.equal(state.jobs[0].dayLogs[ds].notes, text);
  assert.equal(pillOn(), false, 'a successful save clears Unsaved');
  assert.equal(w.document.getElementById('save-alert'), null);
  box.dispatchEvent(new w.Event('blur', { bubbles: true }));
  box.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(pillOn(), false, 'blur or input of the saved note does not bring Unsaved back');
  call('openJobCard', JOB);
  call('jcTab', 'log');
  const again = notesBox(ds);
  assert.equal(again.value, text);
  assert.equal(pillOn(), false, 'reopening the saved card does not show Unsaved');
  typeNote(again, text + ' More.');
  assert.equal(pillOn(), true, 'a new edit shows Unsaved again');
  return again;
}

test('a normal save of today clears Unsaved, and a failed save keeps it', async () => {
  state.mode = 'ok';
  const { today, future } = spanDays();
  const job = baseJob({
    startDate: today,
    endDate: future,
    dayLogs: { [today]: { notes: '', task: '', materialsUsed: [], crewPresent: [], startTime: '', endTime: '' } },
  });
  arm(job, job);
  await saveNoteAndLeaveIt(today, NOTE);
  state.mode = 'network';
  state.patchCalls = [];
  call('openJobCard', JOB);
  call('jcTab', 'log');
  const box = notesBox(today);
  await call('saveJobCard');
  assert.equal(pillOn(), true, 'a failed save leaves Unsaved');
  assert.ok(w.document.getElementById('jc-save-banner'));
  box.dispatchEvent(new w.Event('blur', { bubbles: true }));
  assert.equal(pillOn(), true);
  assert.equal(w.document.getElementById('modal-jobcard').classList.contains('open'), true);
});

test('a normal save of a later day clears Unsaved', async () => {
  state.mode = 'ok';
  const { today, future } = spanDays();
  const job = baseJob({
    startDate: today,
    endDate: future,
    dayLogs: { [today]: { notes: 'already logged', task: '', materialsUsed: [], crewPresent: [], startTime: '', endTime: '' } },
  });
  arm(job, job);
  await saveNoteAndLeaveIt(future, NOTE);
  assert.equal(state.jobs[0].dayLogs[today].notes, 'already logged');
  assert.equal(patchBodies().length, 1, 'the first save is not a retry');
});

test('a save that auto-retries still clears Unsaved', async () => {
  state.mode = 'safe';
  const { today, future } = spanDays();
  const loaded = baseJob({
    startDate: today,
    endDate: future,
    dayLogs: { [future]: { notes: '', task: '', materialsUsed: [], crewPresent: [], startTime: '', endTime: '' } },
  });
  const server = baseJob({
    startDate: today,
    endDate: future,
    updated_at: SERVER_STAMP,
    crewDays: { 'Seth West': [today], 'Brendon Bennett': [future] },
    dayLogs: { [future]: { notes: '', task: '', materialsUsed: [], crewPresent: [], startTime: '', endTime: '' } },
  });
  arm(server, loaded);
  await saveNoteAndLeaveIt(future, NOTE);
  assert.equal(patchBodies().length, 2);
  assert.equal(stampOf(patchBodies()[1][0].expected.updated_at), SERVER_STAMP);
  assert.deepEqual(state.jobs[0].crewDays['Brendon Bennett'], [future]);
});

test('crew still do not see hours or dollar amounts on the log', () => {
  state.mode = 'ok';
  arm(baseJob({ value: '4821.77' }));
  w.localStorage.setItem('fpRole', 'crew');
  openLog();
  const log = w.document.getElementById('jc-pane-log').textContent;
  assert.doesNotMatch(log, /Time on site|Adjust hours|Credited|\$|1\.5×|Cash —/);
  assert.equal(w.document.getElementById('jc-value-group').style.display, 'none');
  assert.equal(w.document.getElementById('jc-tab-costing').style.display, 'none');
  assert.equal(w.document.getElementById('jc-value').value, '');
});
