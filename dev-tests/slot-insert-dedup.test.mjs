/**
 * The same crew member, calendar date, and job must not get a second
 * scheduled_slots row, and a leftover pair must render once.
 * Runs with TZ=America/Chicago so a daylight-time Monday is not a week early.
 * No network. No deletes of the leftover rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

if (process.env.TZ !== 'America/Chicago') {
  test('slot insert dedup reruns with TZ=America/Chicago', { timeout: 180000 }, () => {
    const env = { ...process.env, TZ: 'America/Chicago' };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-timeout=120000', here], {
      env,
      encoding: 'utf8',
    });
    const out = (r.stdout || '') + '\n' + (r.stderr || '');
    assert.equal(r.status, 0, out);
    assert.match(out, /daylight-time Monday does not insert a second row/);
    assert.match(out, /Oct 28 secondary pill does not insert another Burger/);
  });
} else {
  const state = {
    settings: {},
    slots: [],
    posts: 0,
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
    if (u.includes('/rpc/')) {
      return Promise.resolve(jsonResponse({ message: 'could not find the function' }, 404));
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
    if (table === 'scheduled_slots' && method === 'GET') {
      return Promise.resolve(jsonResponse(state.slots));
    }
    if (table === 'scheduled_slots' && method === 'POST') {
      state.posts += 1;
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

  function installPinnedNow(window, localIso) {
    const RealDate = window.Date;
    const fixed = new RealDate(localIso);
    function PinnedDate(...args) {
      if (args.length === 0) return new RealDate(fixed.getTime());
      return new RealDate(...args);
    }
    PinnedDate.prototype = RealDate.prototype;
    PinnedDate.now = () => fixed.getTime();
    PinnedDate.parse = RealDate.parse.bind(RealDate);
    PinnedDate.UTC = RealDate.UTC.bind(RealDate);
    window.Date = PinnedDate;
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
    state.posts = 0;
    state.nextSlotId = 1;
    w.eval(`
      for (const k of Object.keys(newSlots)) delete newSlots[k];
      for (const k of Object.keys(multiSlots)) delete multiSlots[k];
      for (const k of Object.keys(SLOT_JOB_MAP)) delete SLOT_JOB_MAP[k];
      JOB_RECORDS.splice(0, JOB_RECORDS.length);
      _jrBaseline = [];
      _jcId = null;
      _slotsLoadOk = true;
      _jobRecordsLoadOk = true;
      _slotMapLoadOk = true;
      localStorage.removeItem('fpRole');
      sjCrew.splice(0, sjCrew.length);
    `);
  }

  function wipeMemory() {
    w.eval(`
      for (const k of Object.keys(newSlots)) delete newSlots[k];
      for (const k of Object.keys(multiSlots)) delete multiSlots[k];
    `);
  }

  function putJob(job) {
    w.__fpJob = job;
    w.eval('JOB_RECORDS.push(window.__fpJob)');
    w.eval('_jrBaseline = JSON.parse(JSON.stringify(JOB_RECORDS))');
    state.settings.job_records = JSON.stringify(lex('JOB_RECORDS'));
    return job;
  }

  function pos(iso) {
    return w.eval(`seDateToPos(${JSON.stringify(iso)})`);
  }

  function matching(ci, date, label) {
    return state.slots.filter(s => +s.crew_idx === +ci && s.label === label && String(s.job_type).endsWith(':' + date));
  }

  function seedRow(ci, date, label, type, weekOff, dayIdx, id) {
    const row = {
      id: id == null ? state.nextSlotId++ : id,
      crew_idx: ci,
      week_offset: weekOff,
      day_idx: dayIdx,
      label,
      job_type: type + ':' + date,
    };
    state.slots.push(row);
    if (row.id >= state.nextSlotId) state.nextSlotId = row.id + 1;
    return row;
  }

  test.before(async () => {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', () => {});
    dom = new JSDOM(html, {
      url: 'http://127.0.0.1/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        installPinnedNow(window, '2026-11-09T12:00:00');
        window.fetch = mockFetch;
        window.AbortController = AbortController;
        window.confirm = () => true;
        window.CSS = window.CSS || { escape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); } };
      },
    });
    w = dom.window;
    await new Promise(r => setTimeout(r, 50));
    assert.equal(w.eval(`BASE.getFullYear()+'-'+String(BASE.getMonth()+1).padStart(2,'0')+'-'+String(BASE.getDate()).padStart(2,'0')`), '2026-11-09');
    assert.equal(w.eval('BASE.getTimezoneOffset()'), 360);
  });

  test.after(() => {
    if (w) w.close();
  });

  test('dbSaveSlot twice keeps one row, and a different job the same day still inserts', async () => {
    resetBoard();
    const date = '2026-10-28';
    const p = pos(date);
    putJob({ id: 'burger', customer: 'Burger - Main Floor', jobType: 'epoxy', startDate: date, endDate: date, crewNames: 'Seth West', status: 'scheduled', dayLogs: {} });
    putJob({ id: 'other', customer: 'Burger - Main Floor', jobType: 'epoxy', startDate: date, endDate: date, crewNames: 'Seth West', status: 'scheduled', dayLogs: {} });
    await call('dbSaveSlot', 0, p.w, p.d, 'Burger - Main Floor', 'epoxy', date, 'burger');
    wipeMemory();
    await call('dbSaveSlot', 0, p.w, p.d, 'Burger - Main Floor', 'epoxy', date, 'burger');
    assert.equal(matching(0, date, 'Burger - Main Floor').length, 1);
    await call('dbSaveSlot', 0, p.w, p.d, 'Burger - Main Floor', 'epoxy', date, 'other');
    assert.equal(matching(0, date, 'Burger - Main Floor').length, 2, 'a second job record on that day is still saved');
    assert.equal(state.posts, 2);
  });

  test('dbAddExtraSlot twice keeps one row', async () => {
    resetBoard();
    const date = '2026-10-28';
    const p = pos(date);
    putJob({ id: 'burger', customer: 'Burger - Main Floor', jobType: 'epoxy', startDate: date, endDate: date, crewNames: 'Seth West', status: 'scheduled', dayLogs: {} });
    const first = await call('dbAddExtraSlot', 0, p.w, p.d, 'Burger - Main Floor', 'epoxy', 'burger', date);
    assert.equal(first.inserted, true);
    wipeMemory();
    const second = await call('dbAddExtraSlot', 0, p.w, p.d, 'Burger - Main Floor', 'epoxy', 'burger', date);
    assert.equal(second.inserted, false);
    assert.equal(matching(0, date, 'Burger - Main Floor').length, 1);
    const primary = lex('newSlots')[0] && lex('newSlots')[0][p.w] && lex('newSlots')[0][p.w][p.d];
    const extras = lex('getExtraSlots')(0, p.w, p.d).filter(ex => ex.l === 'Burger - Main Floor');
    assert.equal((primary && primary.l === 'Burger - Main Floor' ? 1 : 0) + extras.length, 1);
  });

  test('sePlaceSlot twice keeps one row and the existing map entry', async () => {
    resetBoard();
    const date = '2026-10-28';
    const p = pos(date);
    putJob({ id: 'burger', customer: 'Burger - Main Floor', jobType: 'epoxy', startDate: date, endDate: date, crewNames: 'Seth West', status: 'scheduled', dayLogs: {} });
    const key = w.eval(`jcSlotKey(0, ${p.w}, ${p.d})`);
    w.eval(`SLOT_JOB_MAP[${JSON.stringify(key)}] = 'burger'`);
    assert.equal(await call('sePlaceSlot', 0, p.w, p.d, 'Burger - Main Floor', 'epoxy', 'burger'), true);
    wipeMemory();
    const posts = state.posts;
    assert.equal(await call('sePlaceSlot', 0, p.w, p.d, 'Burger - Main Floor', 'epoxy', 'burger'), true);
    assert.equal(state.posts, posts);
    assert.equal(matching(0, date, 'Burger - Main Floor').length, 1);
    assert.equal(lex('SLOT_JOB_MAP')[key], 'burger');
  });

  function armScheduleForm() {
    w.eval(`
      sjCrew.splice(0, sjCrew.length);
      sjCrew.push(0);
      document.getElementById('sj-days').value = '1';
      document.getElementById('sj-force-date').value = '2026-10-28';
      const wk = document.getElementById('sj-weekends');
      if (wk) wk.checked = false;
      document.getElementById('sj-cust').value = 'Burger - Main Floor';
      document.getElementById('sj-type').value = 'not-a-real-label';
      document.getElementById('sj-val').value = '';
      document.getElementById('sj-notes').value = '';
    `);
    w.eval('sjForceStart()');
  }

  test('sjConfirm twice keeps one row and the first job on the map', async () => {
    resetBoard();
    const date = '2026-10-28';
    const p = pos(date);
    armScheduleForm();
    await call('sjConfirm');
    const key = w.eval(`jcSlotKey(0, ${p.w}, ${p.d})`);
    const firstJob = lex('SLOT_JOB_MAP')[key];
    assert.ok(firstJob);
    assert.equal(matching(0, date, 'Burger - Main Floor').length, 1);
    wipeMemory();
    armScheduleForm();
    const posts = state.posts;
    await call('sjConfirm');
    assert.equal(state.posts, posts);
    assert.equal(matching(0, date, 'Burger - Main Floor').length, 1);
    assert.equal(lex('SLOT_JOB_MAP')[key], firstJob);
  });

  test('jcSyncCrewSlots twice keeps one row', async () => {
    resetBoard();
    const date = '2026-10-28';
    const job = putJob({ id: 'burger', customer: 'Burger - Main Floor', jobType: 'epoxy', startDate: date, endDate: date, crewNames: 'Seth West', status: 'scheduled', dayLogs: {} });
    await call('jcSyncCrewSlots', job);
    assert.equal(matching(0, date, 'Burger - Main Floor').length, 1);
    wipeMemory();
    const posts = state.posts;
    await call('jcSyncCrewSlots', job);
    assert.equal(state.posts, posts);
    assert.equal(matching(0, date, 'Burger - Main Floor').length, 1);
  });

  test('jcSetCrewSlot twice keeps one row', async () => {
    resetBoard();
    const date = '2026-10-28';
    const job = putJob({ id: 'burger', customer: 'Burger - Main Floor', jobType: 'epoxy', startDate: date, endDate: date, crewNames: 'Seth West', status: 'scheduled', dayLogs: {} });
    await call('jcSetCrewSlot', job, 0, date, true);
    assert.equal(matching(0, date, 'Burger - Main Floor').length, 1);
    wipeMemory();
    const posts = state.posts;
    await call('jcSetCrewSlot', job, 0, date, true);
    assert.equal(state.posts, posts);
    assert.equal(matching(0, date, 'Burger - Main Floor').length, 1);
  });

  test('jcRescheduleApply does not insert over a row already stored for that date', async () => {
    resetBoard();
    const from = '2026-10-27';
    const date = '2026-10-28';
    const job = putJob({ id: 'burger', customer: 'Burger - Main Floor', jobType: 'epoxy', startDate: from, endDate: from, crewNames: 'Seth West', status: 'scheduled', dayLogs: {} });
    const origin = pos(from);
    const dest = pos(date);
    seedRow(0, from, 'Burger - Main Floor', 'epoxy', origin.w, origin.d, 11);
    w.eval(`
      if(!newSlots[0]) newSlots[0] = {};
      if(!newSlots[0][${origin.w}]) newSlots[0][${origin.w}] = {};
      newSlots[0][${origin.w}][${origin.d}] = { l: 'Burger - Main Floor', t: 'epoxy', db_id: 11, dt: ${JSON.stringify(from)} };
      SLOT_JOB_MAP[jcSlotKey(0, ${origin.w}, ${origin.d})] = 'burger';
    `);
    // Stale week_offset, correct date in job_type. Not loaded into the grid.
    seedRow(0, date, 'Burger - Main Floor', 'epoxy', dest.w - 1, dest.d, 12);
    const moved = new w.Date(date + 'T00:00:00');
    await call('jcRescheduleApply', [0], [moved], 1, job, date, false);
    assert.equal(matching(0, date, 'Burger - Main Floor').length, 1);
    assert.equal(state.slots.some(s => s.id === 12), true);
    assert.equal(state.posts, 0);
  });

  test('schedHandleCrewReassign does not insert over the target row already stored', async () => {
    resetBoard();
    const date = '2026-10-28';
    const job = putJob({ id: 'burger', customer: 'Burger - Main Floor', jobType: 'epoxy', startDate: date, endDate: date, crewNames: 'Seth West', status: 'scheduled', dayLogs: {} });
    const p = pos(date);
    seedRow(0, date, 'Burger - Main Floor', 'epoxy', p.w, p.d, 21);
    seedRow(1, date, 'Burger - Main Floor', 'epoxy', p.w - 1, p.d, 22);
    w.eval(`
      if(!newSlots[0]) newSlots[0] = {};
      if(!newSlots[0][${p.w}]) newSlots[0][${p.w}] = {};
      newSlots[0][${p.w}][${p.d}] = { l: 'Burger - Main Floor', t: 'epoxy', db_id: 21, dt: ${JSON.stringify(date)} };
      SLOT_JOB_MAP[jcSlotKey(0, ${p.w}, ${p.d})] = 'burger';
    `);
    await call('schedHandleCrewReassign', 0, 1, p.w, p.d, 'burger');
    assert.equal(matching(1, date, 'Burger - Main Floor').length, 1);
    assert.equal(state.slots.some(s => s.id === 22), true);
    assert.equal(state.posts, 0);
  });

  test('Oct 28 secondary pill does not insert another Burger', async () => {
    resetBoard();
    const date = '2026-10-28';
    const p = pos(date);
    assert.equal(p.d, 2);
    const duncan = putJob({ id: 'duncan', customer: 'Steve Duncan', jobType: 'epoxy', startDate: '2026-10-26', endDate: '2026-10-30', crewNames: 'Seth West, Brendon Bennett', status: 'scheduled', dayLogs: {} });
    const burger = putJob({ id: 'burger', customer: 'Burger - Main Floor', jobType: 'epoxy', startDate: date, endDate: date, crewNames: 'Seth West, Brendon Bennett', status: 'scheduled', dayLogs: {} });
    for (const ci of [0, 1]) {
      const duncanRow = seedRow(ci, date, 'Steve Duncan', 'epoxy', p.w, p.d);
      const burgerRow = seedRow(ci, date, 'Burger - Main Floor', 'epoxy', p.w, p.d);
      w.eval(`
        if(!newSlots[${ci}]) newSlots[${ci}] = {};
        if(!newSlots[${ci}][${p.w}]) newSlots[${ci}][${p.w}] = {};
        newSlots[${ci}][${p.w}][${p.d}] = { l: 'Steve Duncan', t: 'epoxy', db_id: ${duncanRow.id}, dt: ${JSON.stringify(date)} };
        multiSlots[_msKey(${ci}, ${p.w}, ${p.d})] = [{ l: 'Burger - Main Floor', t: 'epoxy', db_id: ${burgerRow.id}, jobId: 'burger', dt: ${JSON.stringify(date)} }];
        SLOT_JOB_MAP[jcSlotKey(${ci}, ${p.w}, ${p.d})] = 'duncan';
      `);
    }
    const posts = state.posts;
    await call('jcSyncCrewSlots', burger);
    await call('jcSyncCrewSlots', burger, true);
    for (const ci of [0, 1]) {
      assert.equal(await call('sePlaceSlot', ci, p.w, p.d, 'Burger - Main Floor', 'epoxy', 'burger'), false);
      const extra = await call('dbAddExtraSlot', ci, p.w, p.d, 'Burger - Main Floor', 'epoxy', 'burger', date);
      assert.equal(extra.inserted, false);
      assert.equal(lex('SLOT_JOB_MAP')[w.eval(`jcSlotKey(${ci}, ${p.w}, ${p.d})`)], 'duncan');
      assert.equal(lex('newSlots')[ci][p.w][p.d].l, 'Steve Duncan');
      assert.equal(lex('getExtraSlots')(ci, p.w, p.d).filter(ex => ex.l === 'Burger - Main Floor').length, 1);
    }
    assert.equal(state.posts, posts);
    assert.equal(state.slots.filter(s => s.label === 'Burger - Main Floor').length, 2);
    assert.equal(duncan.customer, 'Steve Duncan');
  });

  test('daylight-time Monday does not insert a second row', async () => {
    resetBoard();
    const date = '2026-10-26';
    assert.equal(w.eval(`Math.floor((new Date('2026-10-26T00:00:00')-BASE)/(7*24*60*60*1000))`), -3);
    const correct = pos(date);
    assert.deepEqual({ w: correct.w, d: correct.d }, { w: -2, d: 0 });
    const job = putJob({ id: 'burger', customer: 'Burger - Main Floor', jobType: 'epoxy', startDate: date, endDate: date, crewNames: 'Seth West', status: 'scheduled', dayLogs: {} });
    seedRow(0, date, 'Burger - Main Floor', 'epoxy', -3, 0, 31);
    const posts = state.posts;
    await call('dbSaveSlot', 0, correct.w, correct.d, 'Burger - Main Floor', 'epoxy', date, 'burger');
    await call('jcSyncCrewSlots', job);
    await call('jcSetCrewSlot', job, 0, date, true);
    assert.equal(await call('sePlaceSlot', 0, correct.w, correct.d, 'Burger - Main Floor', 'epoxy', 'burger'), true);
    assert.equal(state.posts, posts);
    assert.equal(matching(0, date, 'Burger - Main Floor').length, 1);
    assert.equal(state.slots[0].id, 31);
    assert.equal(state.slots[0].week_offset, -3, 'the stored week offset is left as it was');
  });

  test('load renders one bar for duplicate crew+date+job rows and does not delete them', async () => {
    resetBoard();
    const date = '2026-10-28';
    const monday = '2026-10-26';
    const p = pos(date);
    putJob({ id: 'duncan', customer: 'Steve Duncan', jobType: 'epoxy', startDate: '2026-10-26', endDate: '2026-10-30', crewNames: 'Seth West, Brendon Bennett', status: 'scheduled', dayLogs: {} });
    putJob({ id: 'burger', customer: 'Burger - Main Floor', jobType: 'epoxy', startDate: monday, endDate: date, crewNames: 'Seth West, Brendon Bennett', status: 'scheduled', dayLogs: {} });
    for (const ci of [0, 1]) {
      seedRow(ci, date, 'Steve Duncan', 'epoxy', p.w, p.d);
      seedRow(ci, date, 'Burger - Main Floor', 'epoxy', p.w - 1, p.d);
      seedRow(ci, date, 'Burger - Main Floor', 'epoxy', p.w, p.d);
    }
    seedRow(0, monday, 'Burger - Main Floor', 'epoxy', -3, 0);
    seedRow(0, monday, 'Burger - Main Floor', 'epoxy', -2, 0);
    const before = state.slots.length;
    function shown(ci, week, day, label) {
      const primary = lex('newSlots')[ci] && lex('newSlots')[ci][week] && lex('newSlots')[ci][week][day];
      const extras = lex('getExtraSlots')(ci, week, day).filter(ex => ex.l === label);
      return (primary && primary.l === label ? 1 : 0) + extras.length;
    }
    await call('loadScheduledSlots');
    for (const ci of [0, 1]) {
      assert.equal(shown(ci, p.w, p.d, 'Steve Duncan'), 1, 'crew ' + ci + ' shows Steve Duncan once');
      assert.equal(shown(ci, p.w, p.d, 'Burger - Main Floor'), 1, 'crew ' + ci + ' shows Burger once');
    }
    const mon = pos(monday);
    assert.equal(shown(0, mon.w, mon.d, 'Burger - Main Floor'), 1);
    w.eval('weekOffset = -2; renderSchedule();');
    const bars = [...w.document.querySelectorAll('.sch-span-bar')].map(el => el.textContent);
    assert.equal(bars.filter(t => t.includes('Burger - Main Floor')).length, 3, bars.join(' | '));
    assert.equal(bars.filter(t => t.includes('Steve Duncan')).length, 2, bars.join(' | '));
    w.eval(`
      const k = _msKey(0, ${p.w}, ${p.d});
      if(!multiSlots[k]) multiSlots[k] = [];
      multiSlots[k].push({ l: 'Burger - Main Floor', t: 'epoxy', db_id: 999, jobId: null, dt: ${JSON.stringify(date)} });
    `);
    assert.equal(shown(0, p.w, p.d, 'Burger - Main Floor'), 2);
    await call('deduplicateSlotsByJobRecord');
    assert.equal(shown(0, p.w, p.d, 'Burger - Main Floor'), 1);
    assert.equal(state.slots.length, before, 'dedup must not delete scheduled_slots');
    assert.equal(state.slots.some(s => s.week_offset === -3), true);
  });
}
