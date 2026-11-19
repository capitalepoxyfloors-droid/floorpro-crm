/**
 * Photo OK is a job-card field for owner and office. Missing means not yet asked.
 * Saves go out as a normal job patch. Nothing here talks to a database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const JOB = 'photo-sample';
const OLD = 'old-job-no-photo';
const LOADED_STAMP = '2026-11-18T12:00:00.000Z';
const SERVER_STAMP = '2026-11-18T15:04:00.000Z';

const state = {
  mode: 'ok',
  jobs: [],
  patchCalls: [],
  audit: [],
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
        if (state.mode !== 'safe') {
          return Promise.resolve(jsonResponse({ code: 'P0001', message: 'stale_job', details: 'updated_at' }, 400));
        }
      } else {
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
    }
    if (state.mode === 'safe') {
      const first = state.patchCalls.length === 1;
      if (first) {
        return Promise.resolve(jsonResponse({ code: 'P0001', message: 'stale_job', details: 'updated_at' }, 400));
      }
    }
    const nextStamp = '2026-11-18T16:00:00.00' + state.patchCalls.length + 'Z';
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
  if (u.includes('/rest/v1/audit_log') && method === 'POST') {
    state.audit.push(body);
    return Promise.resolve(jsonResponse([{ id: state.audit.length }]));
  }
  if (method === 'GET') return Promise.resolve(jsonResponse([]));
  if (method === 'POST') return Promise.resolve(jsonResponse([{ id: 1 }]));
  return Promise.resolve(new Response(null, { status: 204 }));
}

function job(id, extra) {
  return Object.assign({
    id,
    customer: id === OLD ? 'Older Kitchen' : 'Photo Sample',
    phone: '',
    address: '1 Sample St',
    scope: '',
    jobType: 'epoxy',
    value: '',
    status: 'scheduled',
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

function arm(records) {
  state.mode = 'ok';
  state.patchCalls = [];
  state.audit = [];
  calls.length = 0;
  state.jobs = JSON.parse(JSON.stringify(records));
  const local = JSON.parse(JSON.stringify(records));
  lex('JOB_RECORDS').splice(0, lex('JOB_RECORDS').length, ...local);
  setLex('_jrBaseline', JSON.parse(JSON.stringify(local)));
  setLex('_jcUserEdited', false);
  setLex('_jcSaveIssue', null);
  setLex('_jcId', null);
  w.localStorage.removeItem('fpRole');
  w.localStorage.setItem('fpOfficeUser', 'Pat Office');
  w.document.body.classList.remove('crew-mode', 'crew-preview');
  const type = w.document.getElementById('jc-jobtype');
  type.innerHTML = '<option value="epoxy">Epoxy</option>';
  const oldAlert = w.document.getElementById('save-alert');
  if (oldAlert) oldAlert.remove();
}

function pressed() {
  const btn = w.document.querySelector('#jc-photo-ok [aria-pressed="true"]');
  assert.ok(btn, 'one Photo OK choice is selected');
  return btn.getAttribute('data-photo-ok');
}
function pick(val) {
  call('jcPickPhotoOk', val);
}
function lastPatch() {
  const batches = state.patchCalls;
  assert.ok(batches.length, 'a save was sent');
  return batches[batches.length - 1];
}

test.before(async () => {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/Could not parse CSS|css/i.test(msg)) return;
    throw err;
  });
  dom = new JSDOM(html, {
    url: 'http://127.0.0.1/?env=test',
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

test('a job with no photoOk reads as Not yet asked for office', () => {
  arm([job(OLD), job(JOB)]);
  call('openJobCard', OLD);
  const group = w.document.getElementById('jc-photo-ok-group');
  assert.equal(group.style.display, '');
  assert.equal(pressed(), '');
  assert.equal(group.querySelector('[data-photo-ok=""]')?.textContent, 'Not yet asked');
  assert.equal(lex('JOB_RECORDS').find(j => j.id === OLD).photoOk, undefined);
});

test('Yes, No, then Not yet asked save through the job patch and survive a reload', async () => {
  arm([job(OLD), job(JOB)]);
  call('openJobCard', JOB);
  assert.equal(pressed(), '');

  pick('yes');
  assert.equal(w.document.getElementById('jc-unsaved-pill').style.display, 'inline-flex');
  await call('saveJobCard');
  let patch = lastPatch();
  assert.equal(patch.length, 1);
  assert.equal(patch[0].id, JOB);
  assert.equal(patch[0].op, 'patch');
  assert.equal(patch[0].patch.photoOk, 'yes');
  assert.equal(patch[0].expected.photoOk, null);
  assert.ok(!patch[0].drop || !patch[0].drop.includes('photoOk'));
  assert.equal(Object.prototype.hasOwnProperty.call(state.jobs.find(j => j.id === OLD), 'photoOk'), false);

  call('openJobCard', JOB);
  assert.equal(pressed(), 'yes');
  assert.equal(lex('JOB_RECORDS').find(j => j.id === JOB).photoOk, 'yes');

  pick('no');
  await call('saveJobCard');
  patch = lastPatch();
  assert.equal(patch[0].patch.photoOk, 'no');
  assert.equal(patch[0].expected.photoOk, 'yes');
  call('openJobCard', JOB);
  assert.equal(pressed(), 'no');

  pick('');
  await call('saveJobCard');
  patch = lastPatch();
  assert.equal(patch[0].patch.photoOk, undefined);
  assert.ok(patch[0].drop.includes('photoOk'));
  assert.equal(patch[0].expected.photoOk, 'no');
  const stored = state.jobs.find(j => j.id === JOB);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'photoOk'), false);
  call('openJobCard', JOB);
  assert.equal(pressed(), '');
  assert.equal(Object.prototype.hasOwnProperty.call(state.jobs.find(j => j.id === OLD), 'photoOk'), false);

  const rich = state.audit.map(row => {
    try { return JSON.parse(row.details); } catch { return null; }
  }).filter(Boolean);
  const photoChanges = rich.flatMap(r => (r.changes || []).filter(c => c.label === 'Photo OK'));
  assert.deepEqual(photoChanges.map(c => [c.from, c.to]), [
    ['Not yet asked', 'Yes'],
    ['Yes', 'No'],
    ['No', 'Not yet asked'],
  ]);
});

test('a newer stamp on another field still saves Photo OK on the safe retry', async () => {
  arm([job(JOB)]);
  state.mode = 'safe';
  state.jobs[0].updated_at = SERVER_STAMP;
  state.jobs[0].scope = 'Office added a note';
  call('openJobCard', JOB);
  pick('yes');
  await call('saveJobCard');
  assert.equal(state.patchCalls.length, 2);
  assert.equal(state.patchCalls[1][0].patch.photoOk, 'yes');
  assert.equal(stampOf(state.patchCalls[1][0].expected.updated_at), SERVER_STAMP);
  assert.equal(state.jobs[0].photoOk, 'yes');
  assert.equal(state.jobs[0].scope, 'Office added a note');
  assert.equal(w.document.getElementById('save-alert'), null);
});

test('an overlapping Photo OK change stays unsaved without a technical message', async () => {
  arm([job(JOB, { photoOk: 'no' })]);
  state.jobs[0].photoOk = 'yes';
  call('openJobCard', JOB);
  assert.equal(pressed(), 'no');
  pick('');
  await call('saveJobCard');
  assert.equal(state.jobs[0].photoOk, 'yes', 'server value stays when the field itself conflicts');
  const alert = w.document.getElementById('save-alert');
  assert.ok(alert);
  assert.match(alert.textContent, /Not saved/);
  assert.doesNotMatch(alert.textContent, /stale_job|photoOk|updated_at/);
  assert.equal(pressed(), '');
  await call('jcReloadOpenJob');
  assert.equal(pressed(), '', 'reload keeps the choice still on the card');
  assert.equal(lex('_jrBaseline')[0].photoOk, 'yes');
});

test('a crew login does not see Photo OK and a log save does not clear it', async () => {
  arm([job(JOB, { photoOk: 'yes', scope: 'Keep this' })]);
  w.localStorage.setItem('fpRole', 'crew');
  w.localStorage.removeItem('fpOfficeUser');
  w.document.body.classList.add('crew-mode');
  call('openJobCard', JOB);
  const group = w.document.getElementById('jc-photo-ok-group');
  assert.equal(group.style.display, 'none');
  assert.equal(w.getComputedStyle(group).display, 'none');
  w.document.getElementById('jc-scope').value = 'Crew note';
  await call('saveJobCard');
  const patch = lastPatch();
  assert.equal(patch[0].patch.photoOk, undefined);
  assert.ok(!patch[0].drop || !patch[0].drop.includes('photoOk'));
  assert.equal(patch[0].patch.scope, 'Crew note');
  assert.equal(state.jobs[0].photoOk, 'yes');
});

test('saving a note on an old job does not add photoOk', async () => {
  arm([job(OLD)]);
  call('openJobCard', OLD);
  w.document.getElementById('jc-scope').value = 'Gate code 1234';
  w.document.getElementById('jc-scope').dispatchEvent(new w.Event('input', { bubbles: true }));
  await call('saveJobCard');
  const patch = lastPatch();
  assert.equal(patch[0].patch.scope, 'Gate code 1234');
  assert.equal(patch[0].patch.photoOk, undefined);
  assert.ok(!patch[0].drop || !patch[0].drop.includes('photoOk'));
  assert.equal(Object.prototype.hasOwnProperty.call(state.jobs[0], 'photoOk'), false);
});
