/**
 * Per-day crew assignment against an in-memory fake of the Supabase REST shape.
 * No live network. Extends the same jsdom harness style as prelogin.test.mjs.
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
  nextSlotId: 1,
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
  if (table === 'scheduled_slots' && method === 'POST') {
    const row = { ...body, id: state.nextSlotId++ };
    state.slots.push(row);
    return Promise.resolve(jsonResponse([row]));
  }
  if (table === 'scheduled_slots' && method === 'DELETE') {
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

function resetBoard() {
  state.settings = {};
  state.slots = [];
  state.nextSlotId = 1;
  w.eval(`
    for (const k of Object.keys(newSlots)) delete newSlots[k];
    for (const k of Object.keys(multiSlots)) delete multiSlots[k];
    for (const k of Object.keys(SLOT_JOB_MAP)) delete SLOT_JOB_MAP[k];
    JOB_RECORDS.splice(0, JOB_RECORDS.length);
    _jrBaseline = [];
    _jcId = null;
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

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function slotLabel(ci, iso) {
  return w.eval(`(() => {
    const p = cvDateToSlot(new Date(${JSON.stringify(iso)} + 'T00:00:00'));
    const s = newSlots[${ci}] && newSlots[${ci}][p.w] && newSlots[${ci}][p.w][p.d];
    return s ? s.l : null;
  })()`);
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
      window.confirm = () => true;
      window.CSS = window.CSS || { escape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); } };
    },
  });
  w = dom.window;
  await new Promise(r => setTimeout(r, 50));
});

test.after(() => {
  if (w) w.close();
});

test('old whole-job crew lists still mean every work day, and load does not rewrite them', () => {
  resetBoard();
  const mon = lex('BASE').toISOString().slice(0, 10);
  const fri = addDays(mon, 4);
  const job = putJob({
    id: 'legacy',
    customer: 'Legacy Shop',
    startDate: mon,
    endDate: fri,
    crewNames: 'Seth West, Brendon Bennett',
    status: 'scheduled',
    dayLogs: {},
  });
  assert.equal(job.crewDays, undefined);
  const expected = call('jcJobWorkDates', job);
  assert.deepEqual(plain(expected), [mon, addDays(mon, 1), addDays(mon, 2), addDays(mon, 3), fri]);
  assert.deepEqual(plain(call('jcAssignedDates', job, 'Seth West')), plain(expected));
  assert.deepEqual(plain(call('jcAssignedDates', job, 'Brendon Bennett')), plain(expected));
  call('jcRenderCrewPicker');
  const picker = w.document.getElementById('jc-crew-picker');
  const seth = picker.querySelector('[data-crew-name="Seth West"]');
  const brendon = picker.querySelector('[data-crew-name="Brendon Bennett"]');
  assert.equal(seth.getAttribute('data-on'), '1');
  assert.equal(brendon.getAttribute('data-on'), '1');
  for (const ds of expected) {
    const day = picker.querySelector(`[data-crew-for="Seth West"][data-crew-day="${ds}"]`);
    assert.equal(day.getAttribute('data-on'), '1', ds);
  }
  assert.equal(job.crewDays, undefined, 'opening the picker must not write a day list');
  call('jcMaterializeCrewDays', job);
  assert.deepEqual(plain(job.crewDays['Seth West']), plain(expected));
  assert.deepEqual(plain(job.crewDays['Brendon Bennett']), plain(expected));
  assert.equal(job.crewNames, 'Seth West, Brendon Bennett');
  assert.equal(state.settings.job_records.includes('crewDays'), false, 'materialize stays in memory until a real save');
});

test('assign and unassign a single day, and a sync does not put that day back', async () => {
  resetBoard();
  const mon = lex('BASE').toISOString().slice(0, 10);
  const tue = addDays(mon, 1);
  const wed = addDays(mon, 2);
  const thu = addDays(mon, 3);
  const fri = addDays(mon, 4);
  const log = {
    crewPresent: [{ name: 'Seth West', burdenedRate: 40 }],
    overtimeWage: false,
    task: 'prep',
    startTime: '8:00 AM',
    endTime: '4:00 PM',
  };
  const job = putJob({
    id: 'partial',
    customer: 'Partial Floor',
    startDate: mon,
    endDate: fri,
    crewNames: 'Seth West',
    status: 'scheduled',
    dayLogs: { [wed]: log },
  });
  const logBefore = JSON.stringify(job.dayLogs);
  await call('jcToggleCrewDay', 0, wed);
  assert.equal(job.crewNames, 'Seth West');
  assert.deepEqual(plain(job.crewDays['Seth West']), [mon, tue, thu, fri]);
  assert.equal(slotLabel(0, wed), null);
  assert.equal(JSON.stringify(job.dayLogs), logBefore, 'daily log, OT flag, and crew on site stay put');
  await call('jcSyncCrewSlots', job);
  assert.equal(slotLabel(0, mon), 'Partial Floor');
  assert.equal(slotLabel(0, tue), 'Partial Floor');
  assert.equal(slotLabel(0, wed), null, 'sync must not rebook a day that was turned off');
  assert.equal(slotLabel(0, thu), 'Partial Floor');
  assert.equal(slotLabel(0, fri), 'Partial Floor');
  assert.equal(JSON.stringify(job.dayLogs), logBefore);

  await call('jcToggleCrewDay', 0, wed);
  assert.deepEqual(plain(job.crewDays['Seth West']), [mon, tue, wed, thu, fri]);
  assert.equal(slotLabel(0, wed), 'Partial Floor');

  await call('jcToggleCrewDay', 1, mon);
  assert.ok(job.crewNames.includes('Brendon Bennett'));
  assert.deepEqual(plain(job.crewDays['Brendon Bennett']), [mon]);
  assert.equal(slotLabel(1, mon), 'Partial Floor');
  assert.equal(slotLabel(1, tue), null);
  assert.equal(JSON.stringify(job.dayLogs), logBefore);
});

test('a person can move from job A to job B in the middle of the week', async () => {
  resetBoard();
  const mon = lex('BASE').toISOString().slice(0, 10);
  const tue = addDays(mon, 1);
  const wed = addDays(mon, 2);
  const thu = addDays(mon, 3);
  const jobA = putJob({
    id: 'job-a',
    customer: 'Job A',
    startDate: mon,
    endDate: thu,
    crewNames: 'Seth West',
    status: 'scheduled',
    dayLogs: { [mon]: { overtimeWage: true, crewPresent: [{ name: 'Seth West' }], task: 'day 1' } },
  });
  const logsBefore = JSON.stringify(jobA.dayLogs);
  await call('jcSyncCrewSlots', jobA);
  assert.equal(slotLabel(0, mon), 'Job A');
  assert.equal(slotLabel(0, thu), 'Job A');
  assert.equal(jobA.crewDays, undefined, 'the existing booking is still a whole-job crew list');
  await call('jcToggleCrewDay', 0, wed);
  await call('jcToggleCrewDay', 0, thu);
  assert.deepEqual(plain(jobA.crewDays['Seth West']), [mon, tue]);
  const jobB = putJob({
    id: 'job-b',
    customer: 'Job B',
    startDate: wed,
    endDate: thu,
    crewNames: '',
    status: 'scheduled',
    dayLogs: {},
  });
  await call('jcToggleCrewDay', 0, wed);
  await call('jcToggleCrewDay', 0, thu);
  assert.equal(jobA.crewNames, 'Seth West');
  assert.deepEqual(plain(jobA.crewDays['Seth West']), [mon, tue]);
  assert.equal(jobB.crewNames, 'Seth West');
  assert.deepEqual(plain(jobB.crewDays['Seth West']), [wed, thu]);
  assert.equal(slotLabel(0, mon), 'Job A');
  assert.equal(slotLabel(0, tue), 'Job A');
  assert.equal(slotLabel(0, wed), 'Job B');
  assert.equal(slotLabel(0, thu), 'Job B');
  assert.equal(JSON.stringify(jobA.dayLogs), logsBefore);
  assert.equal(jobA.dayLogs[mon].overtimeWage, true);

  w.eval('_jcId = "job-a"');
  await call('jcSyncCrewSlots', jobA);
  w.eval('_jcId = "job-b"');
  await call('jcSyncCrewSlots', jobB);
  assert.equal(slotLabel(0, mon), 'Job A');
  assert.equal(slotLabel(0, tue), 'Job A');
  assert.equal(slotLabel(0, wed), 'Job B');
  assert.equal(slotLabel(0, thu), 'Job B');
});

test('turning off the last day removes the person, and a legacy sync still books every day', async () => {
  resetBoard();
  const mon = lex('BASE').toISOString().slice(0, 10);
  const job = putJob({
    id: 'one-day',
    customer: 'One Day',
    startDate: mon,
    endDate: mon,
    crewNames: 'Seth West',
    status: 'scheduled',
    dayLogs: {},
  });
  await call('jcSyncCrewSlots', job);
  assert.equal(job.crewDays, undefined, 'sync must not invent a day list');
  assert.equal(slotLabel(0, mon), 'One Day');
  await call('jcToggleCrewDay', 0, mon);
  assert.equal(job.crewNames, '');
  assert.equal(job.crewDays['Seth West'], undefined);
  assert.equal(slotLabel(0, mon), null);
});

test('a one-person drag records only the moved days on the target', () => {
  resetBoard();
  const mon = lex('BASE').toISOString().slice(0, 10);
  const tue = addDays(mon, 1);
  const wed = addDays(mon, 2);
  const thu = addDays(mon, 3);
  const nextMon = addDays(mon, 7);
  const nextTue = addDays(mon, 8);
  const job = putJob({
    id: 'drag',
    customer: 'Drag Job',
    startDate: mon,
    endDate: thu,
    crewNames: 'Brendon Bennett, Cody Faulkner',
    status: 'scheduled',
    dayLogs: {},
  });
  call('jcApplyCrewReassignDays', job, 'Seth West', [mon, tue], 'Cody Faulkner', [nextMon, nextTue], false);
  assert.deepEqual(plain(job.crewDays['Brendon Bennett']), [mon, tue, wed, thu]);
  assert.equal(job.crewDays['Seth West'], undefined);
  assert.deepEqual(plain(job.crewDays['Cody Faulkner']), [nextMon, nextTue]);
});

test('an extra log day is booked only for people who are on the whole job', async () => {
  resetBoard();
  const mon = lex('BASE').toISOString().slice(0, 10);
  const tue = addDays(mon, 1);
  const extra = addDays(mon, 7);
  const job = putJob({
    id: 'extra',
    customer: 'Extra Day',
    startDate: mon,
    endDate: tue,
    crewNames: 'Seth West, Brendon Bennett',
    extraDays: [],
    status: 'scheduled',
    dayLogs: {},
  });
  await call('jcToggleCrewDay', 0, tue);
  assert.deepEqual(plain(job.crewDays['Seth West']), [mon]);
  w.document.getElementById('jc-extra-date').value = extra;
  await call('jcAddExtraDay');
  assert.equal(plain(job.extraDays).includes(extra), true);
  assert.equal(plain(job.crewDays['Seth West']).includes(extra), false);
  assert.equal(plain(job.crewDays['Brendon Bennett']).includes(extra), true);
  assert.equal(slotLabel(0, extra), null);
  assert.equal(slotLabel(1, extra), 'Extra Day');
  assert.equal(job.dayLogs[mon].overtimeWage, undefined);
});

test('crew mode cannot change who is on a day', async () => {
  resetBoard();
  const mon = lex('BASE').toISOString().slice(0, 10);
  const job = putJob({
    id: 'locked',
    customer: 'Locked',
    startDate: mon,
    endDate: mon,
    crewNames: 'Seth West',
    status: 'scheduled',
    dayLogs: {},
  });
  w.document.body.classList.add('crew-mode');
  await call('jcToggleCrewDay', 0, mon);
  await call('jcToggleCrew', 0);
  assert.equal(job.crewDays, undefined);
  assert.equal(job.crewNames, 'Seth West');
  w.document.body.classList.remove('crew-mode');
  const group = w.document.getElementById('jc-crew-picker-group');
  w.document.body.classList.add('crew-mode');
  assert.equal(w.getComputedStyle(group).display, 'none');
  w.document.body.classList.remove('crew-mode');
});
