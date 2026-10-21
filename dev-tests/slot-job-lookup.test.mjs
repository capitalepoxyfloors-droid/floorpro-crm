/**
 * Slot → job lookup (stale SLOT_JOB_MAP + repeat customer) against an in-memory fake of the Supabase REST shape.
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


function setupThomasCase() {
  resetBoard();
  const mon = lex('BASE').toISOString().slice(0, 10);
  const wed = addDays(mon, 2), thu = addDays(mon, 3), fri = addDays(mon, 4);
  // Order matters: the old finished job comes FIRST in JOB_RECORDS, like production.
  putJob({ id: 'thomas-old-aug', customer: 'Thomas Construction', address: '530 Osage River Bridge', startDate: addDays(mon, -62), endDate: addDays(mon, -61), status: 'complete', dayLogs: {} });
  putJob({ id: 'thomas-muirfield', customer: 'Thomas Construction', address: '178 Muirfield Court', startDate: wed, endDate: thu, status: 'in_progress', dayLogs: {} });
  putJob({ id: 'thomas-spray', customer: 'Thomas Construction - Spray Texture', startDate: addDays(mon, -24), endDate: addDays(mon, -20), status: 'complete', dayLogs: {} });
  putJob({ id: 'thomas-older', customer: 'Thomas Construction', startDate: addDays(mon, -90), endDate: addDays(mon, -89), status: 'complete', dayLogs: {} });
  putJob({ id: 'duncan', customer: 'Steve Duncan - SDI, LLC', startDate: mon, endDate: fri, status: 'in_progress', dayLogs: {} });
  w.__fpWed = wed; w.__fpThu = thu;
  w.eval(`
    newSlots[0] = { 0: {
      1: { l: 'Steve Duncan - SDI, LLC', t: 'concrete', dt: '${addDays(mon, 1)}' },
      2: { l: 'Thomas Construction', t: 'flake-good', dt: window.__fpWed },
      3: { l: 'Thomas Construction', t: 'flake-good', dt: window.__fpThu },
    } };
    for (let d = 0; d <= 4; d++) SLOT_JOB_MAP['0_0_' + d] = 'duncan'; // stale: Thomas overwrote Wed/Thu
  `);
  return { mon, wed, thu };
}

test('resolveSlotJob picks the same-named job whose dates cover the slot', () => {
  const { wed } = setupThomasCase();
  assert.equal(call('resolveSlotJob', 0, 0, 2, 'Thomas Construction', wed).id, 'thomas-muirfield');
  assert.equal(call('resolveSlotJob', 0, 0, 2, 'Thomas Construction').id, 'thomas-muirfield', 'date derived from w/d');
  assert.equal(call('resolveSlotJob', 0, 0, 1, 'Steve Duncan - SDI, LLC').id, 'duncan', 'valid map entry trusted');
  assert.equal(call('resolveSlotJob', 0, 0, 2, 'Nobody', wed), null);
});

test('crew view (week spans + day events) shows the Muirfield job, not the old one', () => {
  const { wed } = setupThomasCase();
  const ev = plain(w.eval(`(() => {
    const t = new Date('${wed}T00:00:00'); const sun = new Date(t); sun.setDate(t.getDate() - t.getDay());
    return cvGetWeekSpanEvents(sun);
  })()`));
  const flat = JSON.stringify(ev);
  assert.ok(flat.includes('thomas-muirfield'), 'Muirfield job in crew week: ' + flat.slice(0, 400));
  assert.ok(!flat.includes('thomas-old-aug'), 'old job must not appear');
  const day = plain(w.eval(`cvGetDayEvents(new Date('${wed}T00:00:00'))`));
  const t = day.find(e => e.ci === 0);
  assert.equal(t.jobId, 'thomas-muirfield');
});

test('openSlotEdit routes to the Muirfield job card', () => {
  setupThomasCase();
  w.eval(`window.__fpOpened = null; var __origOJC = openJobCard; openJobCard = id => { window.__fpOpened = id; };`);
  try { w.eval('openSlotEdit(0, 0, 2)'); } finally { w.eval('openJobCard = __origOJC'); }
  assert.equal(w.__fpOpened, 'thomas-muirfield');
});

test('sePlaceSlot repairs a stale SLOT_JOB_MAP entry for the cell it fills', async () => {
  const { wed } = setupThomasCase();
  w.eval(`delete newSlots[0][0][2]`);
  await w.eval(`sePlaceSlot(0, 0, 2, 'Thomas Construction', 'flake-good')`);
  assert.equal(w.eval(`SLOT_JOB_MAP['0_0_2']`), 'thomas-muirfield');
  const saved = JSON.parse(state.settings.slot_job_map || '{}');
  assert.equal(saved['0_0_2'], 'thomas-muirfield', 'map persisted via merged save');
  assert.equal(saved['0_0_1'] ?? w.eval(`SLOT_JOB_MAP['0_0_1']`), 'duncan', 'other keys untouched');
});

test('double-booked overlay: Duncan main + Thomas overlay resolves to Muirfield, not the old job', () => {
  const { mon, wed, thu } = setupThomasCase();
  // Real shape after a reload: Duncan is the primary slot (started earlier), Thomas is the
  // extra/overlay slot with jobId null (not persisted). Map points at Duncan, which is correct.
  w.eval(`
    newSlots[0][0][2] = { l: 'Steve Duncan - SDI, LLC', t: 'concrete', dt: window.__fpWed };
    newSlots[0][0][3] = { l: 'Steve Duncan - SDI, LLC', t: 'concrete', dt: window.__fpThu };
    multiSlots[_msKey(0,0,2)] = [{ l: 'Thomas Construction', t: 'flake-good', db_id: 91, jobId: null, dt: window.__fpWed }];
    multiSlots[_msKey(0,0,3)] = [{ l: 'Thomas Construction', t: 'flake-good', db_id: 92, jobId: null, dt: window.__fpThu }];
  `);
  assert.equal(call('resolveExtraSlotJob', { l: 'Thomas Construction', jobId: null, dt: wed }, wed).id, 'thomas-muirfield');
  const ev = plain(w.eval(`(() => {
    const t = new Date('${wed}T00:00:00'); const sun = new Date(t); sun.setDate(t.getDate() - t.getDay());
    return cvGetWeekSpanEvents(sun);
  })()`));
  const list = Array.isArray(ev) ? ev : Object.values(ev).flat();
  const flat = JSON.stringify(ev);
  assert.ok(flat.includes('thomas-muirfield'), 'overlay bar uses Muirfield: ' + flat.slice(0, 500));
  assert.ok(!flat.includes('thomas-old-aug'), 'old complete job must not appear');
  const thomas = list.filter(e => e && e.label === 'Thomas Construction');
  assert.ok(thomas.length >= 1);
  for (const e of thomas) assert.equal(e.isComplete, false, 'no complete checkmark');
  assert.ok(flat.includes('duncan'), 'Duncan main bar still shown');
  w.eval(`for (const k of Object.keys(multiSlots)) delete multiSlots[k];`);
});
