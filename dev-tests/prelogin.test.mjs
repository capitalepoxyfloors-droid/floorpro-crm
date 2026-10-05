/**
 * Mocked checks for the pre-login safety fixes.
 * Talks only to an in-memory fake of the Supabase REST shape. No live network.
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
  leads: [],
  slots: [],
  materials: [],
  jobs: [],
  failRead: new Set(),
  failSettingsWrite: false,
  failSlotsRead: false,
  phone2Column: true,
  nextLeadId: 1,
  nextSlotId: 1,
};
const calls = [];
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
  calls.push({ url: u, method, body });

  if (!u.includes('/rest/v1/') && !u.includes('/storage/')) {
    return Promise.resolve(new Response('', { status: 200 }));
  }

  if (u.includes('/rest/v1/settings')) {
    if (method === 'GET') {
      const key = settingsKey(u);
      if (state.failRead.has(key)) return Promise.resolve(new Response('read failed', { status: 500 }));
      if (key && Object.prototype.hasOwnProperty.call(state.settings, key)) {
        return Promise.resolve(jsonResponse([{ key, value: state.settings[key] }]));
      }
      return Promise.resolve(jsonResponse([]));
    }
    if (method === 'POST') {
      if (state.failSettingsWrite) return Promise.resolve(new Response('write failed', { status: 500 }));
      if (body && body.key) state.settings[body.key] = body.value;
      return Promise.resolve(jsonResponse([body]));
    }
    if (method === 'DELETE' || method === 'PATCH') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
  }

  const table = (u.split('/rest/v1/')[1] || '').split('?')[0];

  if (table === 'scheduled_slots' && method === 'GET') {
    if (state.failSlotsRead) return Promise.resolve(new Response('slots failed', { status: 500 }));
    return Promise.resolve(jsonResponse(state.slots));
  }
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
  if (table === 'scheduled_slots' && method === 'PATCH') {
    return Promise.resolve(new Response(null, { status: 204 }));
  }

  if (table === 'leads' && method === 'GET') {
    return Promise.resolve(jsonResponse(state.leads));
  }
  if (table === 'leads' && (method === 'POST' || method === 'PATCH')) {
    const sentPhone2 = body && Object.prototype.hasOwnProperty.call(body, 'phone2');
    if (sentPhone2 && !state.phone2Column) {
      return Promise.resolve(jsonResponse({
        code: 'PGRST204',
        message: "Could not find the 'phone2' column of 'leads' in the schema cache",
      }, 400));
    }
    if (method === 'POST') {
      const row = { ...body, id: state.nextLeadId++ };
      if (!state.phone2Column) delete row.phone2;
      state.leads.push(row);
      return Promise.resolve(jsonResponse([row]));
    }
    const m = u.match(/id=eq\.([^&]+)/);
    const id = m ? decodeURIComponent(m[1]) : null;
    const existing = state.leads.find(l => String(l.id) === String(id));
    if (!existing) return Promise.resolve(new Response('missing', { status: 404 }));
    Object.assign(existing, body);
    if (!state.phone2Column) delete existing.phone2;
    return Promise.resolve(jsonResponse([existing]));
  }

  if (table === 'materials' && method === 'GET') return Promise.resolve(jsonResponse(state.materials));
  if (table === 'jobs' && method === 'GET') return Promise.resolve(jsonResponse(state.jobs));
  if (table === 'crew' && method === 'GET') {
    return Promise.resolve(jsonResponse([
      { id: 1, full_name: 'Seth West', first_name: 'Seth', initials: 'SW', color: '#6aabff', role: 'Installer', phone: '', specialties: '[]', hourly: '25', hours: '40', ss: '6.20', medicare: '1.45', futa: '2.70', wc: '10.00', gl: '3.00', benefits: '0', pto_days: '0', sort_order: 0 },
      { id: 2, full_name: 'Brendon Bennett', first_name: 'Brendon', initials: 'BB', color: '#3ddc84', role: 'Installer', phone: '', specialties: '[]', hourly: '25', hours: '40', ss: '6.20', medicare: '1.45', futa: '2.70', wc: '10.00', gl: '3.00', benefits: '0', pto_days: '0', sort_order: 1 },
    ]));
  }
  if (table === 'audit_log' && method === 'POST') return Promise.resolve(jsonResponse([{ id: 1 }]));
  if (method === 'GET') return Promise.resolve(jsonResponse([]));
  if (method === 'POST') return Promise.resolve(jsonResponse([{ id: 1 }]));
  return Promise.resolve(new Response(null, { status: 204 }));
}

function slotWrites() {
  return calls.filter(c => c.url.includes('/scheduled_slots') && (c.method === 'DELETE' || c.method === 'POST'));
}
function settingsDeletes() {
  return calls.filter(c => c.url.includes('/rest/v1/settings') && c.method === 'DELETE');
}
function settingsPostsFor(key) {
  return calls.filter(c => c.method === 'POST' && c.url.includes('/rest/v1/settings') && c.body && c.body.key === key);
}

let dom;
let w;

function syncStatus() {
  return w.document.getElementById('sync-status')?.textContent || '';
}

test('pre-login safety fixes against a mocked backend', async () => {
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
      window.CSS = window.CSS || { escape(s){ return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); } };
    },
  });
  w = dom.window;
  // Top-level `let` bindings are real globals but are not properties of window.
  const lex = (name) => w.eval(name);
  const setLex = (name, value) => { w.__fpTmp = value; w.eval(name + ' = window.__fpTmp'); };
  const call = (name, ...args) => w.eval(name).apply(undefined, args);
  await new Promise(r => setTimeout(r, 30));
  try {

  // ── App boots to the login screen, no console errors, Add Crew is hidden ──
  assert.equal(w.document.getElementById('login-screen').style.display, 'flex', 'login screen should be showing');
  assert.equal(consoleErrors.length, 0, 'console errors on load:\n' + consoleErrors.join('\n'));
  const addBtn = w.document.getElementById('add-crew-member-btn');
  assert.ok(addBtn, 'button node can stay in the page');
  assert.equal(addBtn.hidden, true);
  assert.equal(addBtn.disabled, true);
  assert.equal(addBtn.style.display, 'none');
  assert.equal(w.getComputedStyle(addBtn).display, 'none');
  assert.equal(addBtn.getAttribute('onclick'), null);

  // ── Failed re-read does not write the local job list ──
  lex('JOB_RECORDS').splice(0, lex('JOB_RECORDS').length, { id: 'j1', customer: 'Acme Garage', notes: 'typed on this phone' });
  setLex('_jrBaseline', [{ id: 'j1', customer: 'Acme Garage', notes: 'server notes' }]);
  state.settings.job_records = JSON.stringify(lex('_jrBaseline'));
  state.failRead.add('job_records');
  const postsBefore = settingsPostsFor('job_records').length;
  const saved = await call('_saveJobRecordsNow');
  assert.equal(saved, false);
  assert.equal(settingsPostsFor('job_records').length, postsBefore, 'failed re-read must not POST job_records');
  assert.equal(lex('JOB_RECORDS')[0].notes, 'typed on this phone');
  assert.equal(lex('_jrBaseline')[0].notes, 'server notes', 'baseline must stay put when the write did not happen');
  assert.match(syncStatus(), /nothing was saved/i);
  assert.doesNotMatch(syncStatus(), /✓ Saved/);

  // ── Failed write does not show Saved and does not move the baseline ──
  state.failRead.delete('job_records');
  state.failSettingsWrite = true;
  const baselineSnap = JSON.stringify(lex('_jrBaseline'));
  const savedWrite = await call('_saveJobRecordsNow');
  assert.equal(savedWrite, false);
  assert.equal(JSON.stringify(lex('_jrBaseline')), baselineSnap);
  assert.equal(lex('JOB_RECORDS')[0].notes, 'typed on this phone');
  assert.doesNotMatch(syncStatus(), /✓ Saved/);
  assert.match(syncStatus(), /still here/i);
  assert.equal(settingsDeletes().length, 0, 'setKV must not delete-then-insert');

  // Job card Save uses the same result and must not flash Saved.
  setLex('_jcId', 'j1');
  w.document.getElementById('jc-customer').value = 'Acme Garage';
  w.document.getElementById('jc-phone').value = '';
  w.document.getElementById('jc-address').value = '';
  w.document.getElementById('jc-scope').value = '';
  w.document.getElementById('jc-jobtype').value = 'epoxy';
  w.document.getElementById('jc-value').value = '1000';
  await call('saveJobCard');
  assert.equal(w.document.getElementById('save-badge'), null);
  assert.doesNotMatch(syncStatus(), /✓ Saved/);
  state.failSettingsWrite = false;

  // ── Retry after a good re-read does write, shows Saved, and moves the baseline ──
  const savedOk = await call('_saveJobRecordsNow');
  assert.equal(savedOk, true);
  assert.match(syncStatus(), /✓ Saved/);
  assert.equal(lex('_jrBaseline')[0].notes, 'typed on this phone');
  assert.match(state.settings.job_records, /typed on this phone/);

  // ── Shared KV merge: failed read/write leaves the baseline alone ──
  lex('_kvBaselines').todos = [{ id: 1, text: 'old' }];
  state.failRead.add('todos');
  const todoPosts = settingsPostsFor('todos').length;
  const merged = await call('_saveKVMerged', 'todos', [{ id: 1, text: 'buy tape' }]);
  assert.deepEqual(merged, [{ id: 1, text: 'buy tape' }]);
  assert.equal(settingsPostsFor('todos').length, todoPosts);
  assert.equal(lex('_kvBaselines').todos[0].text, 'old');
  assert.match(syncStatus(), /nothing was saved/i);
  state.failRead.delete('todos');
  state.settings.todos = JSON.stringify([{ id: 1, text: 'old' }]);
  state.failSettingsWrite = true;
  await call('_saveKVMerged', 'todos', [{ id: 1, text: 'buy tape' }]);
  assert.equal(lex('_kvBaselines').todos[0].text, 'old');
  assert.doesNotMatch(syncStatus(), /✓ Saved/);
  state.failSettingsWrite = false;

  // ── Mileage defaults are not written when the rate list failed to load ──
  setLex('MILEAGE_RATES', { tiers: [] });
  state.failRead.add('mileage_rates');
  const milePosts = settingsPostsFor('mileage_rates').length;
  await call('loadMileageRates');
  assert.equal(settingsPostsFor('mileage_rates').length, milePosts);
  assert.equal(lex('MILEAGE_RATES').tiers.length, 0);
  state.failRead.delete('mileage_rates');
  consoleErrors.length = 0;

  // ── Crew load does not delete or insert schedule slots ──
  const job = {
    id: 'job-acme',
    customer: 'Acme Garage',
    startDate: '2026-06-01',
    endDate: '2026-06-05',
    crewNames: 'Seth West',
    extraDays: ['2026-06-08'],
    status: 'scheduled',
    dayLogs: {
      '2026-06-02': { materialsUsed: [{ name: 'Polyurea', qty: '1', usageUnit: 'Gallon' }] },
    },
  };
  state.settings.job_records = JSON.stringify([job]);
  state.settings.slot_job_map = JSON.stringify({});
  state.settings.schedule_base_date = lex('BASE').toISOString().split('T')[0];
  state.settings.mileage_rates = JSON.stringify({ tiers: [{ id: 'mr1', rate: '0.70', effective: '2000-01-01' }] });
  state.settings.lead_quoted_dates = JSON.stringify({});
  state.materials = [{ id: 7, name: 'Polyurea', mfr: '', cat: '', unit: '2 Gallon', price: '50', price_date: '', coverage: '', coverage_unit: '', supplier: '', notes: '' }];
  state.slots = [
    { id: 99, crew_idx: 0, week_offset: 0, day_idx: 0, label: 'Acme Garage', job_type: 'epoxy:2020-01-06' },
    { id: 100, crew_idx: 0, week_offset: 0, day_idx: 1, label: 'Acme Garage', job_type: 'epoxy:2026-06-02' },
  ];
  state.leads = [{ id: 5, name: 'Pat Example', phone: '314-555-0100', phone2: '314-555-0199', email: '', job_type: 'Epoxy Flake', cust_type: 'Residential', sqft: '', value: '5000', address: '1 Main St', source: '', notes: '', stage: 'new', detail: '', date_added: 'Added Jun 1' }];
  w.localStorage.setItem('fpRole', 'crew');
  const callMark = calls.length;
  await call('loadAllFromSupabase');
  const crewSlotWrites = calls.slice(callMark).filter(c => c.url.includes('/scheduled_slots') && (c.method === 'DELETE' || c.method === 'POST'));
  assert.equal(crewSlotWrites.length, 0, 'crew load wrote slots: ' + JSON.stringify(crewSlotWrites));
  assert.equal(state.slots.some(s => s.id === 99), true, 'out-of-range slot must still be on the server');

  // ── Owner load removes only the bad slot, and can fill a missing extra day ──
  state.slots = [
    { id: 99, crew_idx: 0, week_offset: 0, day_idx: 0, label: 'Acme Garage', job_type: 'epoxy:2020-01-06' },
    { id: 100, crew_idx: 0, week_offset: 0, day_idx: 1, label: 'Acme Garage', job_type: 'epoxy:2026-06-02' },
  ];
  w.localStorage.removeItem('fpRole');
  const ownerMark = calls.length;
  await call('loadAllFromSupabase');
  const ownerSlotWrites = calls.slice(ownerMark).filter(c => c.url.includes('/scheduled_slots') && (c.method === 'DELETE' || c.method === 'POST'));
  const ownerDeletes = ownerSlotWrites.filter(c => c.method === 'DELETE');
  assert.ok(ownerDeletes.some(c => c.url.includes('id=eq.99')), 'owner load should delete the out-of-range slot');
  assert.equal(ownerDeletes.some(c => c.url.includes('id=eq.100')), false, 'in-range slot must stay');
  assert.ok(ownerSlotWrites.some(c => c.method === 'POST'), 'missing extra-day slot should be created for the owner');

  // ── A failed slots read must not delete whatever is already in memory ──
  lex('newSlots')[0] = { 0: { 0: { l: 'Acme Garage', t: 'epoxy', db_id: 77, dt: '2020-01-06' } } };
  state.failSlotsRead = true;
  const failMark = calls.length;
  await call('loadAllFromSupabase');
  const failDeletes = calls.slice(failMark).filter(c => c.url.includes('/scheduled_slots') && c.method === 'DELETE');
  assert.equal(failDeletes.length, 0);
  assert.equal(lex('newSlots')[0][0][0].db_id, 77);
  state.failSlotsRead = false;
  consoleErrors.length = 0;

  // ── Opening a job card does not write slots, including for crew ──
  setLex('_crewLoaded', true);
  w.localStorage.setItem('fpRole', 'crew');
  const openMark = calls.length;
  call('openJobCard', 'job-acme');
  await new Promise(r => setTimeout(r, 20));
  const openWrites = calls.slice(openMark).filter(c => c.url.includes('/scheduled_slots') && (c.method === 'DELETE' || c.method === 'POST' || c.method === 'PATCH'));
  assert.equal(openWrites.length, 0, 'openJobCard wrote slots: ' + JSON.stringify(openWrites));
  assert.match(w.document.getElementById('jc-name').textContent, /Acme Garage/);

  // ── Split shifts: two Full Day rows count 8; otherwise hours add ──
  w.localStorage.removeItem('fpRole');
  lex('CREW_DATA')[0].hourly = '20';
  const costJob = {
    id: 'cost1',
    customer: 'Split Shift Shop',
    status: 'complete',
    value: '2000',
    startDate: '2026-06-23',
    endDate: '2026-06-23',
    consumablesPct: 10,
    dayLogs: {
      '2026-06-23': {
        fullDay: true,
        crewPresent: [
          { name: 'Seth West', crewIdx: 0 },
          { name: 'Seth West', crewIdx: 0 },
        ],
        materialsUsed: [],
      },
    },
  };
  lex('JOB_RECORDS').splice(0, lex('JOB_RECORDS').length, costJob);
  setLex('_jcId', 'cost1');
  call('renderJobCosting');
  assert.match(w.document.getElementById('jc-costing-content').textContent, /8\.0 hrs total/);
  let pay = call('_payrollCompute', 0).rows.find(r => r.label === 'Seth West');
  assert.ok(pay, 'Seth should be on the payroll worksheet');
  assert.equal(pay.regHrs, 8);

  costJob.dayLogs['2026-06-23'].fullDay = false;
  costJob.dayLogs['2026-06-23'].crewPresent = [
    { name: 'Seth West', crewIdx: 0, startTime: '8:00 AM', endTime: '12:00 PM' },
    { name: 'Seth West', crewIdx: 0, startTime: '1:00 PM', endTime: '4:00 PM' },
  ];
  call('renderJobCosting');
  assert.match(w.document.getElementById('jc-costing-content').textContent, /7\.0 hrs total/);
  pay = call('_payrollCompute', 0).rows.find(r => r.label === 'Seth West');
  assert.equal(pay.regHrs, 7);

  costJob.dayLogs['2026-06-23'].crewPresent = [
    { name: 'Seth West', crewIdx: 0, startTime: '6:00 AM', endTime: '2:00 PM' },
    { name: 'Seth West', crewIdx: 0, startTime: '2:00 PM', endTime: '10:00 PM' },
  ];
  call('renderJobCosting');
  assert.match(w.document.getElementById('jc-costing-content').textContent, /16\.0 hrs total/);
  pay = call('_payrollCompute', 0).rows.find(r => r.label === 'Seth West');
  assert.equal(pay.regHrs, 16);
  call('renderJobCostingPage');
  assert.match(w.document.getElementById('jc-cost-page-content').textContent, /16h logged/);

  // Whole-day OT checkbox still multiplies the counted hours by 1.5, and a Full Day is still 8.
  costJob.dayLogs['2026-06-23'].fullDay = true;
  costJob.dayLogs['2026-06-23'].overtimeWage = true;
  costJob.dayLogs['2026-06-23'].crewPresent = [
    { name: 'Seth West', crewIdx: 0 },
    { name: 'Seth West', crewIdx: 0 },
  ];
  pay = call('_payrollCompute', 0).rows.find(r => r.label === 'Seth West');
  assert.equal(pay.otHrs, 8);
  assert.equal(pay.regHrs, 0);
  assert.equal(Math.round(pay.otPay), 240);
  costJob.dayLogs['2026-06-23'].overtimeWage = false;
  costJob.dayLogs['2026-06-23'].fullDay = false;

  // ── Frozen material unit cost ──
  const mi = lex('MATERIALS').findIndex(m => m.name === 'Polyurea');
  if (mi < 0) {
    lex('MATERIALS').push({ db_id: 7, name: 'Polyurea', unit: '2 Gallon', price: '50' });
  }
  const matIdx = lex('MATERIALS').findIndex(m => m.name === 'Polyurea');
  lex('MATERIALS')[matIdx].unit = '2 Gallon';
  lex('MATERIALS')[matIdx].price = '50';
  costJob.dayLogs['2026-06-23'].materialsUsed = [{ matIdx, name: 'Polyurea', qty: '', usageUnit: 'Gallon', matId: lex('MATERIALS')[matIdx].db_id }];
  call('jcLogSetMaterial', '2026-06-23', 0, 'qty', '4');
  assert.equal(costJob.dayLogs['2026-06-23'].materialsUsed[0].unitCost, 25);
  lex('MATERIALS')[matIdx].price = '80';
  call('renderJobCosting');
  assert.match(w.document.getElementById('jc-costing-content').textContent, /\$100\.00/);
  assert.doesNotMatch(w.document.getElementById('jc-costing-content').textContent, /\$160\.00/);
  call('renderJobCostingPage');
  const summary = w.document.getElementById('jc-cost-page-content').textContent;
  assert.match(summary, /\$100\.00/);

  // A line with no stored cost still follows today's price.
  costJob.dayLogs['2026-06-23'].materialsUsed = [{ matIdx, name: 'Polyurea', qty: '1', usageUnit: 'Gallon', matId: lex('MATERIALS')[matIdx].db_id }];
  lex('MATERIALS')[matIdx].price = '80';
  call('renderJobCosting');
  assert.match(w.document.getElementById('jc-costing-content').textContent, /\$40\.00/);
  call('renderJobCostingPage');
  assert.match(w.document.getElementById('jc-cost-page-content').textContent, /\$40\.00/);

  // ── Secondary phone round-trip, and a missing column does not block the save ──
  setLex('_leadsPhone2Ok', true);
  state.phone2Column = true;
  state.leads = [];
  const lead = { name: 'Pat Example', phone: '314-555-0100', phone2: '314-555-0199', email: 'pat@example.com', stage: 'new', jobType: 'Epoxy Flake', custType: 'Residential', sqft: '', value: '5000', address: '1 Main St', source: 'Referral', notes: '', detail: '', date: 'Added Jun 1' };
  const leadOk = await call('dbSaveLead', lead);
  assert.equal(leadOk, true);
  assert.ok(lead.db_id);
  assert.equal(state.leads[0].phone2, '314-555-0199');
  await call('loadLeads');
  assert.equal(lex('LEADS')[0].phone2, '314-555-0199');
  call('renderPipeline');
  assert.match(w.document.getElementById('pipeline-board').textContent, /Pat Example/);
  assert.match(w.document.getElementById('pipeline-board').textContent, /314-555-0199/);

  setLex('_leadsPhone2Ok', true);
  state.phone2Column = false;
  state.leads = [];
  const lead2 = { name: 'Sam Example', phone: '314-555-0102', phone2: '314-555-0103', email: '', stage: 'new', notes: '', detail: '', date: '' };
  const leadMark = calls.length;
  const lead2Ok = await call('dbSaveLead', lead2);
  assert.equal(lead2Ok, true);
  assert.ok(lead2.db_id);
  const leadPosts = calls.slice(leadMark).filter(c => c.url.includes('/rest/v1/leads') && c.method === 'POST');
  assert.equal(leadPosts.length, 2, 'missing phone2 column should retry once');
  assert.equal(Object.prototype.hasOwnProperty.call(leadPosts[0].body, 'phone2'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(leadPosts[1].body, 'phone2'), false);
  assert.equal(state.leads[0].name, 'Sam Example');
  assert.equal(state.leads[0].phone, '314-555-0102');

  // ── Main screens still render on the sample data ──
  call('renderSchedule');
  assert.ok(w.document.getElementById('sched-container').textContent.length > 0);
  call('renderPayroll');
  assert.match(w.document.getElementById('payroll-content').textContent, /Regular Payroll/);
  call('renderDashboard');
  assert.ok(w.document.getElementById('dash-grid').children.length > 0);

  const lateErrors = consoleErrors.filter(e => !/css/i.test(e));
  assert.equal(lateErrors.length, 0, 'console errors during checks:\n' + lateErrors.join('\n'));
  } finally {
    try { w.close(); } catch { /* page timers keep the process alive otherwise */ }
  }
});
