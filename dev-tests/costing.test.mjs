/**
 * Costing change (direct labor rate, separate overhead, effective-dated stamps) against an
 * in-memory fake of the Supabase REST shape. No live network. Same jsdom harness style as
 * crew-days.test.mjs. Crew pay numbers below are the ones in the costing spec (2026-10-20).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const state = { settings: {}, crewRows: [], patches: [], audit: [] };
const consoleErrors = [];

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
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
  if (!u.includes('/rest/v1/') && !u.includes('/storage/')) return Promise.resolve(new Response('', { status: 200 }));
  if (u.includes('/rest/v1/settings')) {
    if (method === 'GET') {
      const key = settingsKey(u);
      if (key && Object.prototype.hasOwnProperty.call(state.settings, key)) return Promise.resolve(jsonResponse([{ key, value: state.settings[key] }]));
      return Promise.resolve(jsonResponse([]));
    }
    if (method === 'POST') { if (body && body.key) state.settings[body.key] = body.value; return Promise.resolve(jsonResponse([body])); }
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  const table = (u.split('/rest/v1/')[1] || '').split('?')[0];
  if (table === 'crew' && method === 'GET') return Promise.resolve(jsonResponse(state.crewRows));
  if (table === 'crew' && method === 'PATCH') { state.patches.push({ url: u, body }); return Promise.resolve(new Response(null, { status: 204 })); }
  if (table === 'audit_log' && method === 'POST') { state.audit.push(body); return Promise.resolve(jsonResponse([{ id: state.audit.length, ...body }])); }
  if (method === 'GET') return Promise.resolve(jsonResponse([]));
  if (method === 'POST') return Promise.resolve(jsonResponse([{ id: 1 }]));
  return Promise.resolve(new Response(null, { status: 204 }));
}

let dom, w;
const ev = (src) => w.eval(src);
const plain = (v) => JSON.parse(JSON.stringify(v));
function call(name, ...args) { w.__fpArgs = args; return w.eval(name + '.apply(undefined, window.__fpArgs)'); }

// Live crew table order (sort_order): Seth 0, Brendon 1, Will 2, Cody 3, Hunter 4.
const base = { hours: '40', ss: '6.20', medicare: '1.45', futa: '0.60', wc: '3.62', gl: '0', pto_days: '10', role: 'Installer', color: '#888', initials: 'XX', phone: '', specialties: '[]' };
const CREW_ROWS = [
  { ...base, id: 'seth', full_name: 'Seth West', first_name: 'Seth', last_name: 'West', hourly: '30.25', benefits: '135', pto_days: '12', sort_order: 0,
    futa_wage_base: 7000, suta_rate: 1.848, suta_wage_base: 9000, k401_match_pct: 4, fixed_fees_yr: 830, clothing_yr: 204, field_rate_override: null, is_owner: false },
  { ...base, id: 'brendon', full_name: 'Brendon Bennett', first_name: 'Brendon', last_name: 'Bennett', hourly: '27.60', benefits: '100', pto_days: '11', sort_order: 1,
    futa_wage_base: 7000, suta_rate: 1.848, suta_wage_base: 9000, k401_match_pct: 4, fixed_fees_yr: 830, clothing_yr: 204, field_rate_override: null, is_owner: false },
  { ...base, id: 'will', full_name: 'Will Bradford', first_name: 'Will', last_name: 'Bradford', hourly: '72.11', benefits: '0', wc: '5.61', futa: '2.70', sort_order: 2,
    futa_wage_base: null, suta_rate: null, suta_wage_base: null, k401_match_pct: null, fixed_fees_yr: null, clothing_yr: null, field_rate_override: 40.27, is_owner: true },
  { ...base, id: 'cody', full_name: 'Cody Faulkner', first_name: 'Cody', last_name: 'Faulkner', hourly: '25.20', benefits: '0', wc: '5.61', futa: '2.70', sort_order: 3,
    futa_wage_base: null, suta_rate: null, suta_wage_base: null, k401_match_pct: null, fixed_fees_yr: null, clothing_yr: null, field_rate_override: null, is_owner: false },
  { ...base, id: 'hunter', full_name: 'Hunter Schuler', first_name: 'Hunter', last_name: 'Schuler', hourly: '24.00', benefits: '0', sort_order: 4,
    futa_wage_base: 7000, suta_rate: 1.848, suta_wage_base: 9000, k401_match_pct: 0, fixed_fees_yr: 830, clothing_yr: 204, field_rate_override: null, is_owner: false },
];

async function freshCrewAndSettings({ settings } = {}) {
  state.settings = settings ? { ...settings } : {};
  state.crewRows = plain(CREW_ROWS);
  state.patches = [];
  state.audit = [];
  ev(`CREW_INACTIVE = {3:{since:'2026-09-28',name:'Cody Faulkner'}}; JOB_RECORDS.splice(0, JOB_RECORDS.length); _jrBaseline = [];`);
  await ev('loadCrew()');
  await ev('loadCostingSettings()');
}
const r2 = (n) => Math.round(n * 100) / 100;

test.before(async () => {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/Could not parse CSS|css/i.test(msg)) return;
    consoleErrors.push(msg);
  });
  virtualConsole.on('error', (...args) => { consoleErrors.push(args.map(a => (a && a.stack) ? a.stack : String(a)).join(' ')); });
  dom = new JSDOM(html, {
    url: 'http://127.0.0.1/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
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
test.after(() => { if (w) w.close(); });

test('overhead per hour is 15.32 and the owner and inactive crew are not in the divisor', async () => {
  await freshCrewAndSettings();
  assert.equal(ev('_costingSettingsLoadOk'), true);
  assert.equal(r2(ev('overheadPerHour()')), 15.32);
  const names = plain(ev('_overheadCrew().map(c=>c.full)'));
  assert.deepEqual(names, ['Seth West', 'Brendon Bennett', 'Hunter Schuler']);
  assert.equal(ev('overheadAnnualLaborHours()'), 3 * 2080 * 0.9);
  // Sensitivity shown on the Overhead page
  assert.equal(r2(ev('overheadPerHour(undefined,0.85)')), 16.22);
  assert.equal(r2(ev('overheadPerHour(undefined,0.92)')), 14.98);
  // overheadMode 'pool' is the default; 'items' divides the itemized list instead
  assert.equal(ev('costingCurrentModel().entry.overheadMode'), 'pool');
  ev(`OVERHEAD = {items:[{id:'a',name:'Rent',amount:'2000',period:'mo'},{id:'b',name:'GL',amount:'5616',period:'yr'}]}`);
  assert.equal(r2(ev(`overheadPerHour({...costingCurrentModel().entry, overheadMode:'items'})`)), r2((24000 + 5616) / 5616));
  ev('OVERHEAD = {items:[]}');
  // A missing settings row is seeded once (owner session) and audit-logged
  const saved = JSON.parse(state.settings.costing_settings);
  assert.equal(saved.history.length, 2);
  assert.equal(saved.history[1].overheadPool, 86014);
  assert.ok(state.audit.some(a => a.action === 'costing_settings_changed'));
});

test('direct rates match the spec, and OT is 1.5 x hourly x (1+SS+Medicare+WC)', async () => {
  await freshCrewAndSettings();
  const rate = (i) => plain(ev(`calcDirectRate(CREW_DATA[${i}])`));
  assert.equal(rate(0).direct, 40.27);          // Seth
  assert.equal(rate(0).ot, 50.49);
  assert.equal(r2(rate(0).annual), 75390.2);
  assert.ok(Math.abs(rate(1).direct - 36.66) <= 0.03, 'Brendon ' + rate(1).direct);
  assert.equal(rate(2).direct, 40.27);          // Will: field_rate_override
  assert.equal(rate(2).override, 40.27);
  assert.equal(rate(4).direct, 30.34);          // Hunter with 830 + 204 (spec says 29.97 — see notes)
  // Cody has no new fields filled in → old burden math, without overhead
  const cody = plain(ev('crewLaborRates(CREW_DATA[3])'));
  assert.equal(cody.model, 'fallback');
  assert.equal(cody.direct, parseFloat(ev('calcBurdenForCrew(CREW_DATA[3])')));
});

test('a crew pick stamps directRate 40.27 and overheadRate 15.32; save never re-stamps', async () => {
  await freshCrewAndSettings();
  const ds = '2026-10-20';
  w.__job = { id: 'j1', customer: 'Test Garage', status: 'in_progress', startDate: ds, endDate: ds,
    dayLogs: { [ds]: { crewPresent: [{ crewIdx: -1, name: '', burdenedRate: '' }], startTime: '7:00 AM', endTime: '3:00 PM' } } };
  ev('JOB_RECORDS.push(window.__job); _jcId="j1"; _jrBaseline=JSON.parse(JSON.stringify(JOB_RECORDS));');
  state.settings.job_records = JSON.stringify(plain(ev('JOB_RECORDS')));
  ev(`jcLogPickCrewMember('${ds}', 0, {value:'0'})`);
  const c = plain(ev(`getJobRecord('j1').dayLogs['${ds}'].crewPresent[0]`));
  assert.equal(c.name, 'Seth West');
  assert.equal(c.directRate, 40.27);
  assert.equal(c.overheadRate, 15.32);
  assert.equal(c.otRate, 50.49);
  assert.equal(c.rateVersion, 'cs_20261020');
  assert.equal(c.burdenedRate, '55.59');
  // Change Seth's pay, then save: the stamped entry keeps its rate
  ev(`CREW_DATA[0].hourly='35.00'`);
  ev(`_jcStampMissingRates()`);
  assert.equal(ev(`getJobRecord('j1').dayLogs['${ds}'].crewPresent[0].directRate`), 40.27);
  // ...until the person is explicitly picked again
  ev(`jcLogPickCrewMember('${ds}', 0, {value:'0'})`);
  assert.ok(ev(`getJobRecord('j1').dayLogs['${ds}'].crewPresent[0].directRate`) > 40.27);
  ev(`CREW_DATA[0].hourly='30.25'`);
});

test('save stamps missing rates only on direct-model days, never on older days', async () => {
  await freshCrewAndSettings();
  w.__job = { id: 'j2', customer: 'Mixed', status: 'in_progress', startDate: '2026-10-01', endDate: '2026-10-20', dayLogs: {
    '2026-10-01': { crewPresent: [{ crewIdx: 1, name: 'Brendon Bennett', burdenedRate: '38.58' }], fullDay: true },
    '2026-10-20': { crewPresent: [{ crewIdx: 1, name: 'Brendon Bennett', burdenedRate: '38.58' }, { crewIdx: 2, name: 'Will Bradford', burdenedRate: '' }], fullDay: true },
    '2099-01-05': { crewPresent: [{ crewIdx: 0, name: 'Seth West', burdenedRate: '' }], fullDay: true },
  } };
  ev('JOB_RECORDS.push(window.__job); _jrBaseline=JSON.parse(JSON.stringify(JOB_RECORDS));');
  state.settings.job_records = JSON.stringify(plain(ev('JOB_RECORDS')));
  await ev('saveJobRecords()');
  const saved = JSON.parse(state.settings.job_records).find(j => j.id === 'j2');
  const old = saved.dayLogs['2026-10-01'].crewPresent[0];
  assert.equal(old.burdenedRate, '38.58');
  assert.equal(old.directRate, undefined, 'an older day is never re-stamped');
  const [b, will] = saved.dayLogs['2026-10-20'].crewPresent;
  assert.ok(Math.abs(b.directRate - 36.66) <= 0.03);
  assert.equal(b.overheadRate, 15.32);
  assert.equal(will.directRate, 40.27);
  assert.equal(will.fieldOverride, true);
  assert.equal(will.overheadRate, 15.32, "the owner's field hours carry overhead too");
  assert.equal(saved.dayLogs['2099-01-05'].crewPresent[0].directRate, undefined, 'future days wait for their date');
});

test('old unstamped logs cost exactly what they did before (as recorded)', async () => {
  await freshCrewAndSettings();
  const job = { id: 'j3', customer: 'Old', status: 'complete' };
  const ds = '2026-09-10';
  w.__a = [job, ds];
  // Plain day: stored all-in rate, unchanged
  const plainDay = ev(`jcGetBurdenedRate({crewIdx:0,burdenedRate:'41.12'}, window.__a[0], {}, window.__a[1])`);
  assert.equal(r2(plainDay), 41.12);
  const split = plain(ev(`jcEntryRate({crewIdx:0,burdenedRate:'41.12'}, window.__a[0], {}, window.__a[1])`));
  assert.equal(split.kind, 'legacy');
  assert.equal(r2(split.labor), r2(41.12 - 4.83));
  assert.equal(split.overhead, 4.83);
  // OT day: old code was stored × 1.5
  assert.equal(r2(ev(`jcGetBurdenedRate({crewIdx:0,burdenedRate:'41.12'}, window.__a[0], {overtimeWage:true}, window.__a[1])`)), r2(41.12 * 1.5));
  // Cash day: base hourly × multiplier, no overhead
  assert.equal(ev(`jcGetBurdenedRate({crewIdx:0,burdenedRate:'41.12'}, {cashWages:true,overtimeWage:true}, {}, window.__a[1])`), 30.25 * 1.5);
  // Old prevailing-wage job (no burden flag): flat PW rate, no overhead
  assert.equal(ev(`jcGetBurdenedRate({crewIdx:0,burdenedRate:'41.12'}, {prevailingWage:true,prevailingWageRate:44.7}, {}, window.__a[1])`), 44.7);
});

test('prevailing wage, cash and owner rules on direct-model days', async () => {
  await freshCrewAndSettings();
  const ds = '2026-10-20';
  ev(`window.__seth={crewIdx:0,name:'Seth West'}; jcStampEntryRates(window.__seth,'${ds}'); window.__will={crewIdx:2,name:'Will Bradford'}; jcStampEntryRates(window.__will,'${ds}');`);
  const mult = 1 + 0.062 + 0.0145 + 0.0362;
  const pwNew = plain(ev(`jcEntryRate(window.__seth,{prevailingWage:true,prevailingWageRate:44.7,prevailingWageBurden:true},{},'${ds}')`));
  assert.equal(r2(pwNew.labor), r2(44.7 * mult));
  assert.equal(pwNew.overhead, 15.32);
  const pwOld = plain(ev(`jcEntryRate(window.__seth,{prevailingWage:true,prevailingWageRate:44.7},{},'${ds}')`));
  assert.equal(pwOld.labor, 44.7, 'a PW job without the new flag stays unburdened');
  const cash = plain(ev(`jcEntryRate(window.__seth,{cashWages:true},{},'${ds}')`));
  assert.equal(cash.labor, 30.25);
  assert.equal(cash.overhead, 15.32, 'cash hours still carry overhead');
  const ot = plain(ev(`jcEntryRate(window.__seth,{},{overtimeWage:true},'${ds}')`));
  assert.equal(ot.labor, 50.49);
  const ownerCashOt = plain(ev(`jcEntryRate(window.__will,{cashWages:true,overtimeWage:true},{},'${ds}')`));
  assert.equal(ownerCashOt.labor, 40.27, "the owner's override applies on cash/OT days");
  // Re-cost mode prices an old legacy entry at today's rates (nothing written)
  const re = plain(ev(`jcEntryRate({crewIdx:0,burdenedRate:'41.12'},{},{},'2026-09-10','recost')`));
  assert.equal(re.labor, 40.27);
  assert.equal(r2(re.overhead), 15.32);
});

test('saving a crew member writes back every existing column value', async () => {
  await freshCrewAndSettings();
  for (let i = 0; i < CREW_ROWS.length; i++) {
    state.patches = [];
    await ev(`dbSaveCrew(CREW_DATA[${i}], ${i})`);
    assert.equal(state.patches.length, 1);
    const sent = state.patches[0].body;
    const orig = CREW_ROWS[i];
    for (const [k, v] of Object.entries(orig)) {
      if (k === 'id') continue;
      assert.deepEqual(sent[k], v, `${orig.full_name}: column ${k}`);
    }
  }
});

test('a failed or unreadable costing_settings read stops stamping', async () => {
  await freshCrewAndSettings({ settings: { costing_settings: 'not json' } });
  assert.equal(ev('_costingSettingsLoadOk'), false);
  ev(`window.__c={crewIdx:0,name:'Seth West'}; jcStampEntryRates(window.__c,'2026-10-20');`);
  assert.equal(ev('window.__c.directRate'), undefined);
  assert.equal(state.settings.costing_settings, 'not json', 'a bad row is never overwritten by the seed');
});

test('crew cannot write costing_settings (it is not on the crew settings allowlist)', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261009143000_rls_pin_auth_private_storage.sql'), 'utf8');
  const lists = [...sql.matchAll(/key IN \(([^)]*)\)/g)].map(m => m[1]);
  assert.ok(lists.length >= 3, 'found the crew allowlists');
  for (const l of lists) assert.ok(!l.includes('costing_settings'), 'crew allowlist must not include costing_settings');
  const mig = fs.readFileSync(path.join(root, 'supabase/migrations/20261020120000_crew_costing_columns.sql'), 'utf8');
  assert.ok(!/\bDROP\b|\bRENAME\b|job_records/i.test(mig.replace(/--.*$/gm, '')), 'migration only adds columns');
});

test('no page errors', () => {
  assert.deepEqual(consoleErrors.filter(e => !/fetch|network|Not implemented|loadCostingSettings: saved value is not usable/i.test(e)), []);
});
