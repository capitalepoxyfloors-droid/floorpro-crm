/**
 * Reschedule membership and the owner slot-map cleanup.
 * A leftover slot_job_map key or an old slot row must not put a removed or
 * inactive person back on the new dates. Cleanup never deletes scheduled_slots.
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
  settings: {},
  slots: [],
  audits: [],
  slotDeletes: [],
  nextSlotId: 1,
};

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

function mockFetch(url, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const u = String(url);
  let body = null;
  if (opts.body && typeof opts.body === 'string') {
    try { body = JSON.parse(opts.body); } catch { body = opts.body; }
  }
  if (!u.includes('/rest/v1/') && !u.includes('/storage/')) {
    return Promise.resolve(new Response('', { status: 200 }));
  }
  if (u.includes('/rest/v1/settings')) {
    if (method === 'GET') {
      const key = settingsKey(u);
      if (key && Object.prototype.hasOwnProperty.call(state.settings, key)) {
        return Promise.resolve(jsonResponse([{ key, value: state.settings[key] }]));
      }
      return Promise.resolve(jsonResponse([]));
    }
    if (method === 'POST') {
      if (body && body.key) state.settings[body.key] = body.value;
      return Promise.resolve(jsonResponse([body]));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  const table = (u.split('/rest/v1/')[1] || '').split('?')[0];
  if (table === 'audit_log' && method === 'POST') {
    state.audits.push(body);
    return Promise.resolve(jsonResponse([body]));
  }
  if (table === 'scheduled_slots' && method === 'POST') {
    const row = { ...body, id: state.nextSlotId++ };
    state.slots.push(row);
    return Promise.resolve(jsonResponse([row]));
  }
  if (table === 'scheduled_slots' && method === 'DELETE') {
    state.slotDeletes.push(u);
    const m = u.match(/id=eq\.(\d+)/);
    if (m) state.slots = state.slots.filter(s => String(s.id) !== m[1]);
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  if (method === 'GET') return Promise.resolve(jsonResponse([]));
  if (method === 'POST') return Promise.resolve(jsonResponse([{ id: 1 }]));
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

async function settle(){
  await new Promise(r => setTimeout(r, 30));
}

function resetBoard() {
  state.settings = {};
  state.slots = [];
  state.audits = [];
  state.slotDeletes = [];
  state.nextSlotId = 1;
  w.eval(`
    for (const k of Object.keys(newSlots)) delete newSlots[k];
    for (const k of Object.keys(multiSlots)) delete multiSlots[k];
    for (const k of Object.keys(SLOT_JOB_MAP)) delete SLOT_JOB_MAP[k];
    JOB_RECORDS.splice(0, JOB_RECORDS.length);
    _jrBaseline = [];
    _jcId = null;
    CREW_INACTIVE = {};
    _slotMapCleanupReady = false;
    localStorage.removeItem('fpRole');
    localStorage.removeItem('fpOfficeUser');
  `);
}

function addDays(iso, n) {
  return w.eval(`(() => {
    const d = new Date(${JSON.stringify(iso)} + 'T00:00:00');
    d.setDate(d.getDate() + ${n});
    return d.toISOString().slice(0, 10);
  })()`);
}

function putJob(job) {
  w.__fpJob = job;
  w.eval('JOB_RECORDS.push(window.__fpJob)');
  w.eval('_jrBaseline = JSON.parse(JSON.stringify(JOB_RECORDS))');
  w.eval('_jcId = window.__fpJob.id');
  state.settings.job_records = JSON.stringify(lex('JOB_RECORDS'));
  return job;
}

function publishMap() {
  state.settings.slot_job_map = JSON.stringify(lex('SLOT_JOB_MAP'));
  w.eval('_kvBaselines.slot_job_map = JSON.parse(JSON.stringify(SLOT_JOB_MAP))');
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function pos(ci, iso) {
  return w.eval(`cvDateToSlot(new Date(${JSON.stringify(iso)} + 'T00:00:00'))`);
}

function slotLabel(ci, iso) {
  return w.eval(`(() => {
    const p = cvDateToSlot(new Date(${JSON.stringify(iso)} + 'T00:00:00'));
    const s = newSlots[${ci}] && newSlots[${ci}][p.w] && newSlots[${ci}][p.w][p.d];
    return s ? s.l : null;
  })()`);
}

function extraLabels(ci, iso) {
  return w.eval(`(() => {
    const p = cvDateToSlot(new Date(${JSON.stringify(iso)} + 'T00:00:00'));
    return getExtraSlots(${ci}, p.w, p.d).map(x => x.l);
  })()`);
}

function putMemorySlot(ci, iso, label, dbId, jobId) {
  const p = pos(ci, iso);
  w.__fpSlot = { l: label, t: 'epoxy', db_id: dbId, dt: iso };
  w.eval(`
    if(!newSlots[${ci}]) newSlots[${ci}] = {};
    if(!newSlots[${ci}][${p.w}]) newSlots[${ci}][${p.w}] = {};
    newSlots[${ci}][${p.w}][${p.d}] = window.__fpSlot;
  `);
  if (jobId) w.eval(`SLOT_JOB_MAP[jcSlotKey(${ci}, ${p.w}, ${p.d})] = ${JSON.stringify(jobId)}`);
  state.slots.push({
    id: dbId,
    crew_idx: ci,
    week_offset: p.w,
    day_idx: p.d,
    label,
    job_type: 'epoxy:' + iso,
  });
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
  assert.match(lex('SUPABASE_URL'), /nndjnywtkgxwvxajwztg/);
});

test.after(() => {
  if (w) w.close();
});

test('reschedule carries current crew only and leaves the other job in a shared square', async () => {
  await settle();
  resetBoard();
  const mon = lex('BASE').toISOString().slice(0, 10);
  const tue = addDays(mon, 1);
  const wed = addDays(mon, 2);
  const nextMon = addDays(mon, 7);
  const nextTue = addDays(mon, 8);
  const nextWed = addDays(mon, 9);
  const job = putJob({
    id: 'noblett',
    customer: 'Noblett Shop',
    startDate: mon,
    endDate: wed,
    crewNames: 'Will Bradford, Seth West',
    crewDays: { 'Seth West': [mon] },
    status: 'scheduled',
    jobType: 'epoxy',
    dayLogs: {},
  });
  w.eval(`CREW_INACTIVE = {3:{since:'2026-09-28', name:'Cody Faulkner'}};`);
  putMemorySlot(2, mon, 'Noblett Shop', 11, 'noblett');
  putMemorySlot(2, tue, 'Noblett Shop', 12, 'noblett');
  putMemorySlot(2, wed, 'Noblett Shop', 13, 'noblett');
  putMemorySlot(0, mon, 'Noblett Shop', 14, 'noblett');
  // Cody was taken off the crew. His old row and a past-week map key are still here.
  putMemorySlot(3, mon, 'Noblett Shop', 21, 'noblett');
  w.eval(`SLOT_JOB_MAP['3_-4_1'] = 'noblett'`);
  // A different job shares Will's old Monday as a double-booked extra, and owns next Monday.
  const willMon = pos(2, mon);
  w.eval(`multiSlots['2_${willMon.w}_${willMon.d}'] = [{l:'Side Job', t:'epoxy', db_id:31, jobId:'side', dt:${JSON.stringify(mon)}}]`);
  putMemorySlot(2, nextMon, 'Keep Me', 41, 'keep-job');
  putJob({
    id: 'keep-job',
    customer: 'Keep Me',
    startDate: nextMon,
    endDate: nextMon,
    crewNames: 'Will Bradford',
    status: 'scheduled',
    dayLogs: {},
  });
  w.eval(`_jcId = 'noblett'`);
  const newDates = call('getWorkingDaysFrom', nextMon, 3, false);
  await call('jcRescheduleApply', [3, 2, 0], newDates, 3, job, nextMon, true);

  assert.equal(slotLabel(3, nextMon), null);
  assert.equal(slotLabel(3, nextTue), null);
  assert.equal(slotLabel(3, nextWed), null);
  assert.equal(slotLabel(3, mon), null, 'Cody’s old Noblett row leaves with the old dates');
  assert.equal(lex('SLOT_JOB_MAP')['3_-4_1'], undefined);
  assert.equal(slotLabel(2, nextMon), 'Keep Me', 'the other job stays the primary in that square');
  assert.deepEqual(plain(extraLabels(2, nextMon)), ['Noblett Shop']);
  assert.equal(slotLabel(2, nextTue), 'Noblett Shop');
  assert.equal(slotLabel(2, nextWed), 'Noblett Shop');
  assert.equal(slotLabel(0, nextMon), 'Noblett Shop');
  assert.equal(slotLabel(0, nextTue), 'Noblett Shop');
  assert.equal(slotLabel(0, nextWed), 'Noblett Shop');
  assert.deepEqual(plain(extraLabels(2, mon)), ['Side Job']);
  assert.equal(job.crewNames, 'Will Bradford, Seth West');
  assert.equal(job.crewDays, undefined, 'people who moved are on every new day');
  assert.equal(job.startDate, nextMon);
  assert.equal(job.endDate, nextWed);
  assert.equal(state.slots.some(s => s.id === 41), true, 'the other job’s slot row was not deleted');
  assert.equal(state.slots.some(s => s.id === 21), false);
});

test('an inactive person still named on the job is not booked, including by sync', async () => {
  await settle();
  resetBoard();
  const mon = lex('BASE').toISOString().slice(0, 10);
  const tue = addDays(mon, 1);
  const wed = addDays(mon, 2);
  const nextMon = addDays(mon, 7);
  const job = putJob({
    id: 'noblett',
    customer: 'Noblett Shop',
    startDate: mon,
    endDate: wed,
    crewNames: 'Will Bradford, Cody Faulkner',
    status: 'scheduled',
    jobType: 'epoxy',
    dayLogs: {},
  });
  w.eval(`CREW_INACTIVE = {3:{since:'2026-09-28', name:'Cody Faulkner'}};`);
  putMemorySlot(2, mon, 'Noblett Shop', 51, 'noblett');
  putMemorySlot(2, tue, 'Noblett Shop', 52, 'noblett');
  putMemorySlot(2, wed, 'Noblett Shop', 53, 'noblett');
  putMemorySlot(3, mon, 'Noblett Shop', 54, 'noblett');
  w.eval(`SLOT_JOB_MAP['3_9_0'] = 'noblett'`);
  const newDates = call('getWorkingDaysFrom', nextMon, 3, false);
  await call('jcRescheduleApply', [3], newDates, 3, job, nextMon, false);
  assert.equal(slotLabel(3, nextMon), null);
  assert.equal(slotLabel(2, nextMon), 'Noblett Shop');
  assert.deepEqual(plain(job.crewDays['Cody Faulkner']), []);
  assert.equal(job.crewDays['Will Bradford'], undefined);
  assert.equal(lex('SLOT_JOB_MAP')['3_9_0'], undefined);

  await call('jcSyncCrewSlots', job);
  assert.equal(slotLabel(3, nextMon), null, 'saving or healing the job must not book inactive crew');
  assert.equal(slotLabel(2, addDays(mon, 8)), 'Noblett Shop');
});

test('the reschedule dialog uses the job record, not the slot map', async () => {
  await settle();
  resetBoard();
  const mon = lex('BASE').toISOString().slice(0, 10);
  const wed = addDays(mon, 2);
  const nextMon = addDays(mon, 7);
  const nextWed = addDays(mon, 9);
  putJob({
    id: 'noblett',
    customer: 'Noblett Shop',
    startDate: mon,
    endDate: wed,
    crewNames: 'Will Bradford',
    status: 'scheduled',
    jobType: 'epoxy',
    dayLogs: {},
  });
  w.eval(`CREW_INACTIVE = {3:{since:'2026-09-28', name:'Cody Faulkner'}};`);
  w.eval(`SLOT_JOB_MAP['3_0_0'] = 'noblett'; SLOT_JOB_MAP['3_-2_2'] = 'noblett';`);
  w.document.getElementById('rs-new-start').value = nextMon;
  w.document.getElementById('rs-duration').value = '3';
  w.document.getElementById('rs-include-weekends').checked = false;
  await call('jcRescheduleConfirm');
  assert.equal(slotLabel(3, nextMon), null);
  assert.equal(slotLabel(3, nextWed), null);
  assert.equal(slotLabel(2, nextMon), 'Noblett Shop');
  assert.equal(slotLabel(2, nextWed), 'Noblett Shop');
});

test('dragging a job onto an inactive person does not book them', async () => {
  await settle();
  resetBoard();
  const mon = lex('BASE').toISOString().slice(0, 10);
  const job = putJob({
    id: 'noblett',
    customer: 'Noblett Shop',
    startDate: mon,
    endDate: mon,
    crewNames: 'Will Bradford',
    status: 'scheduled',
    jobType: 'epoxy',
    dayLogs: {},
  });
  w.eval(`CREW_INACTIVE = {3:{since:'2026-09-28', name:'Cody Faulkner'}};`);
  putMemorySlot(2, mon, 'Noblett Shop', 61, 'noblett');
  const target = pos(3, addDays(mon, 7));
  await call('schedHandleCrewReassign', 2, 3, target.w, target.d, job.id);
  assert.equal(slotLabel(2, mon), 'Noblett Shop');
  assert.equal(job.crewNames, 'Will Bradford');
  assert.equal(slotLabel(3, addDays(mon, 7)), null);
});

test('slot map cleanup previews first, then removes only stale keys', async () => {
  await settle();
  resetBoard();
  const mon = lex('BASE').toISOString().slice(0, 10);
  const sun = addDays(mon, -1);
  const old = addDays(mon, -14);
  putJob({
    id: 'noblett',
    customer: 'Noblett Shop',
    startDate: mon,
    endDate: mon,
    crewNames: 'Will Bradford',
    status: 'scheduled',
    dayLogs: {},
  });
  putJob({
    id: 'keep-job',
    customer: 'Keep Me',
    startDate: old,
    endDate: old,
    crewNames: 'Seth West',
    status: 'complete',
    dayLogs: {},
  });
  const sunPos = pos(2, sun);
  const oldPos = pos(0, old);
  const cur = pos(2, mon);
  w.eval(`
    SLOT_JOB_MAP[jcSlotKey(${cur.ci || 2}, ${cur.w}, ${cur.d})] = 'noblett';
    SLOT_JOB_MAP['3_9_1'] = '4f8330df-e374-48b3-8c8d-33ef0c325b36';
    SLOT_JOB_MAP[jcSlotKey(0, ${oldPos.w}, ${oldPos.d})] = 'keep-job';
    SLOT_JOB_MAP[jcSlotKey(${sunPos.w < 0 ? 2 : 2}, ${sunPos.w}, ${sunPos.d})] = 'noblett';
    SLOT_JOB_MAP['not-a-key'] = 'noblett';
  `);
  putMemorySlot(0, old, 'Keep Me', 71, 'keep-job');
  publishMap();
  const beforeMap = plain(lex('SLOT_JOB_MAP'));
  const beforeSlots = state.slots.map(s => s.id);
  const deletesBefore = state.slotDeletes.length;

  await call('jcPreviewSlotMapCleanup');
  assert.deepEqual(plain(lex('SLOT_JOB_MAP')), beforeMap);
  assert.deepEqual(state.slots.map(s => s.id), beforeSlots);
  assert.equal(state.slotDeletes.length, deletesBefore);
  assert.equal(state.audits.length, 0);
  const preview = w.document.getElementById('slot-map-cleanup-preview').textContent;
  assert.match(preview, /3_9_1 → 4f8330df-e374-48b3-8c8d-33ef0c325b36/);
  assert.match(preview, /job is not in job records/);
  assert.match(preview, /past week/);
  assert.match(preview, /No scheduled jobs are deleted/);
  assert.equal(w.document.getElementById('slot-map-cleanup-run').style.display, '');

  await call('jcRunSlotMapCleanup');
  const map = lex('SLOT_JOB_MAP');
  assert.equal(map['3_9_1'], undefined);
  assert.equal(map['not-a-key'], undefined);
  assert.equal(map[`${oldPos.w === undefined ? '' : '0_' + oldPos.w + '_' + oldPos.d}`], undefined);
  assert.equal(map[`2_${cur.w}_${cur.d}`], 'noblett', 'this week’s key for a real job stays');
  assert.equal(map[`2_${sunPos.w}_${sunPos.d}`], 'noblett', 'Sunday opening this week still means something');
  assert.equal(state.slots.some(s => s.id === 71), true, 'cleanup must not delete scheduled_slots');
  assert.equal(state.slotDeletes.length, deletesBefore);
  const removed = state.audits.filter(a => a.action === 'slot_map_removed');
  assert.ok(removed.length >= 3);
  assert.ok(removed.some(a => a.entity === '3_9_1' && String(a.details).includes('4f8330df-e374-48b3-8c8d-33ef0c325b36')));
  assert.ok(removed.every(a => a.action === 'slot_map_removed'));
});

test('office and crew cannot run the slot map cleanup', async () => {
  await settle();
  resetBoard();
  putJob({
    id: 'noblett',
    customer: 'Noblett Shop',
    startDate: lex('BASE').toISOString().slice(0, 10),
    endDate: lex('BASE').toISOString().slice(0, 10),
    crewNames: 'Will Bradford',
    status: 'scheduled',
    dayLogs: {},
  });
  w.eval(`SLOT_JOB_MAP['3_9_1'] = '4f8330df-e374-48b3-8c8d-33ef0c325b36'`);
  publishMap();
  w.localStorage.setItem('fpOfficeUser', 'Grok – Ops Manager');
  await call('jcPreviewSlotMapCleanup');
  await call('jcRunSlotMapCleanup');
  assert.equal(lex('SLOT_JOB_MAP')['3_9_1'], '4f8330df-e374-48b3-8c8d-33ef0c325b36');
  assert.equal(state.audits.length, 0);
  w.localStorage.removeItem('fpOfficeUser');
  w.localStorage.setItem('fpRole', 'crew');
  await call('jcPreviewSlotMapCleanup');
  assert.equal(state.audits.length, 0);
  assert.equal(w.document.getElementById('slot-map-cleanup-block').style.display, '');
  call('showPage', 'pinsettings');
  assert.equal(w.document.getElementById('slot-map-cleanup-block').style.display, 'none');
});
