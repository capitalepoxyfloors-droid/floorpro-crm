/**
 * Page-load lead follow-up and costing-settings writes.
 * In memory only — does not call the live or test Supabase project.
 *
 * The 7-day Estimate Sent move used to run for every non-crew sign-in and
 * save the whole lead under that person's name. It now runs only for the
 * owner, changes only stage, and only while the row is still quoted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const COSTING_SAVED = JSON.stringify({
  history: [
    { id: 'cs_legacy', effective: '1900-01-01', legacyOverheadPerHour: 4.83 },
    { id: 'cs_20261020', effective: '2026-10-20', utilization: 0.9, paidHoursPerYear: 2080, overheadMode: 'pool', overheadPool: 86014 },
  ],
});

const state = {
  settings: {},
  leads: [],
  audit: [],
  raceIds: new Set(),
};
const calls = [];

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
function queryValue(url, key) {
  const q = String(url).split('?')[1] || '';
  const m = q.match(new RegExp('(?:^|&)' + key + '=eq\\.([^&]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function leadRow(over) {
  return {
    id: 11,
    name: 'Kampeter Remodeling',
    phone: '573-555-0142',
    phone2: '573-555-0199',
    email: 'job@kampeter.example',
    job_type: 'Epoxy Flake',
    cust_type: 'Commercial',
    sqft: '2400',
    value: '18000',
    address: '1 Job St',
    source: 'Referral',
    notes: 'Keep this note',
    stage: 'quoted',
    detail: 'Garage',
    date_added: 'Oct 1',
    ...over,
  };
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
  const table = (u.split('/rest/v1/')[1] || '').split('?')[0];
  if (table === 'leads' && method === 'GET') return Promise.resolve(jsonResponse(state.leads.map(r => ({ ...r }))));
  if (table === 'leads' && method === 'PATCH') {
    const id = queryValue(u, 'id');
    const stageFilter = queryValue(u, 'stage');
    const row = state.leads.find(r => String(r.id) === String(id));
    if (!row) return Promise.resolve(jsonResponse([]));
    if (state.raceIds.has(String(id))) return Promise.resolve(jsonResponse([]));
    if (stageFilter && row.stage !== stageFilter) return Promise.resolve(jsonResponse([]));
    Object.assign(row, body || {});
    return Promise.resolve(jsonResponse([{ ...row }]));
  }
  if (method === 'GET') return Promise.resolve(jsonResponse([]));
  if (method === 'POST') return Promise.resolve(jsonResponse([{ id: 'posted' }]));
  return Promise.resolve(new Response(null, { status: 204 }));
}

let dom;
let w;
const consoleErrors = [];

function lex(name) {
  return w.eval(name);
}
function call(name, ...args) {
  w.__fpArgs = args;
  return w.eval(name + '.apply(undefined, window.__fpArgs)');
}
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}
function leadCalls(method) {
  return calls.filter(c => c.url.includes('/rest/v1/leads') && c.method === method);
}
function settingsPosts(key) {
  return calls.filter(c => c.method === 'POST' && c.url.includes('/rest/v1/settings') && c.body && c.body.key === key);
}
function leadAudits() {
  return state.audit.filter(a => a && a.action === 'lead_updated');
}

function signIn({ kind, name, officeId }) {
  w.localStorage.removeItem('fpRole');
  w.localStorage.removeItem('fpOfficeUser');
  w.localStorage.removeItem('fpAuth_v2');
  const accountKind = kind === 'pm' || kind === 'agent' ? 'office' : kind;
  if (kind === 'crew') w.localStorage.setItem('fpRole', 'crew');
  if (accountKind === 'office') w.localStorage.setItem('fpOfficeUser', name);
  const blob = {
    kind: accountKind,
    display_name: name,
    office_id: officeId || null,
    role: kind === 'crew' ? 'crew' : 'admin',
    refresh_token: 'rt',
    access_token: 'at',
    ts: Date.now(),
  };
  w.localStorage.setItem('fpAuth_v2', JSON.stringify(blob));
  w.__fpWho = { kind: accountKind, display_name: name, office_id: blob.office_id, crew_idx: null };
  w.eval('_signedInAccount = window.__fpWho');
}

function quietSettings() {
  const base = lex('BASE').toISOString().split('T')[0];
  state.settings = {
    schedule_base_date: base,
    job_records: '[]',
    slot_job_map: '{}',
    mileage_rates: JSON.stringify({ tiers: [{ id: 'mr1', rate: '0.70', effective: '2000-01-01' }] }),
    costing_settings: COSTING_SAVED,
    lead_quoted_dates: JSON.stringify({}),
    lead_dup_acks: '{}',
  };
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
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    },
  });
  w = dom.window;
  await new Promise(r => setTimeout(r, 40));
});

test.after(() => { if (w) w.close(); });

function resetNetwork() {
  calls.length = 0;
  state.audit = [];
  state.raceIds = new Set();
  state.leads = [];
  quietSettings();
}

test('office, PM, and agent page loads do not move leads or write a lead audit', async () => {
  const stale = leadRow({ id: 11, name: 'Kampeter Remodeling', stage: 'quoted', notes: 'Keep this note', value: '18000' });
  const sessions = [
    { kind: 'office', name: 'Grok – Ops Manager', officeId: 'ops1' },
    { kind: 'pm', name: 'PM - Helias', officeId: 'c7e1aa20' },
    { kind: 'agent', name: 'Agent – Survey', officeId: 'ag99' },
  ];
  for (const session of sessions) {
    resetNetwork();
    state.leads = [JSON.parse(JSON.stringify(stale))];
    state.settings.lead_quoted_dates = JSON.stringify({ '11': daysAgo(8) });
    const before = JSON.stringify(state.leads[0]);
    signIn(session);
    const mark = calls.length;
    await call('loadAllFromSupabase');
    const during = calls.slice(mark);
    const patches = during.filter(c => c.url.includes('/rest/v1/leads') && c.method === 'PATCH');
    const audits = state.audit.filter(a => a && a.action === 'lead_updated');
    assert.equal(patches.length, 0, session.name + ' patched a lead: ' + JSON.stringify(patches));
    assert.equal(audits.length, 0, session.name + ' wrote lead_updated');
    assert.equal(JSON.stringify(state.leads[0]), before, session.name + ' changed the lead row');
    assert.equal(state.leads[0].stage, 'quoted');
    assert.equal(state.leads[0].notes, 'Keep this note');
    if (session.kind === 'pm') {
      const fetches = during.filter(c => c.url.includes('/rest/v1/leads'));
      assert.equal(fetches.length, 0, 'PM session fetched leads: ' + JSON.stringify(fetches.map(c => c.method + ' ' + c.url)));
      assert.equal(lex('LEADS').length, 0);
    } else {
      assert.ok(during.some(c => c.url.includes('/rest/v1/leads') && c.method === 'GET'), session.name + ' should still be able to read leads');
    }
  }
});

test('a PM session does not fetch leads', async () => {
  resetNetwork();
  state.leads = [leadRow({ id: 11, stage: 'quoted' })];
  signIn({ kind: 'pm', name: 'PM Salvation', officeId: 'not-a-role-code' });
  const mark = calls.length;
  await call('loadLeads');
  const fetches = calls.slice(mark).filter(c => c.url.includes('/rest/v1/leads'));
  assert.equal(fetches.length, 0);
  assert.equal(lex('LEADS').length, 0);
  assert.equal(lex('_leadsLoadOk'), false);
});

test('owner load moves a stale quoted lead with a stage-only conditional update and a System audit', async () => {
  resetNetwork();
  state.leads = [
    leadRow({ id: 11, name: 'Kampeter Remodeling', stage: 'quoted', notes: 'Keep this note', phone: '573-555-0142', value: '18000' }),
    leadRow({ id: 12, name: 'Fresh Quote', stage: 'quoted', notes: 'Too new', phone: '111' }),
  ];
  state.settings.lead_quoted_dates = JSON.stringify({ '11': daysAgo(8) });
  signIn({ kind: 'owner', name: 'Will Bradford', officeId: null });
  await call('loadAllFromSupabase');

  const patches = leadCalls('PATCH');
  assert.equal(patches.length, 1);
  const patch = patches[0];
  assert.match(patch.url, /\/rest\/v1\/leads\?/);
  assert.match(patch.url, /(?:^|[?&])id=eq\.11(?:&|$)/);
  assert.match(patch.url, /(?:^|[?&])stage=eq\.quoted(?:&|$)/);
  assert.deepEqual(patch.body, { stage: 'followup' });

  const moved = state.leads.find(r => r.id === 11);
  const fresh = state.leads.find(r => r.id === 12);
  assert.equal(moved.stage, 'followup');
  assert.equal(moved.notes, 'Keep this note');
  assert.equal(moved.phone, '573-555-0142');
  assert.equal(moved.phone2, '573-555-0199');
  assert.equal(moved.value, '18000');
  assert.equal(moved.address, '1 Job St');
  assert.equal(fresh.stage, 'quoted', 'a quote younger than 7 days stays put');

  const timers = JSON.parse(state.settings.lead_quoted_dates);
  assert.equal(timers['11'], undefined, 'the 7-day timer is cleared after the move');
  assert.ok(timers['12'], 'the new quote starts its 7-day timer');

  const audits = leadAudits();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, 'System \u2013 auto Follow-Up after 7 days: Kampeter Remodeling');
  assert.equal(audits[0].action, 'lead_updated');
  assert.equal(audits[0].entity, 'Kampeter Remodeling');
  assert.equal(audits[0].details, 'Stage: followup');
  assert.equal(audits[0].actor.includes('Will Bradford'), false);
  assert.equal(audits[0].actor.includes('Manager'), false);
});

test('a lead that was already moved is left untouched', async () => {
  resetNetwork();
  const already = leadRow({
    id: 21, name: 'Already Moved', stage: 'followup', notes: 'Do not rewrite', phone: '222', value: '900',
  });
  state.leads = [JSON.parse(JSON.stringify(already))];
  state.settings.lead_quoted_dates = JSON.stringify({ '21': daysAgo(10) });
  signIn({ kind: 'owner', name: 'Will Bradford', officeId: null });
  await call('loadAllFromSupabase');

  assert.equal(leadCalls('PATCH').length, 0);
  assert.equal(leadAudits().length, 0);
  assert.deepEqual(state.leads[0], already);
  const timers = JSON.parse(state.settings.lead_quoted_dates);
  assert.equal(timers['21'], undefined, 'a timer for a lead that is no longer Estimate Sent is cleared');

  // The read still said Estimate Sent, but the row was moved before the save.
  // The conditional update matches nothing, so the other fields stay as they were.
  resetNetwork();
  state.leads = [leadRow({ id: 22, name: 'Race Lead', stage: 'quoted', notes: 'Still the original note', phone: '333', value: '4200' })];
  state.raceIds.add('22');
  state.settings.lead_quoted_dates = JSON.stringify({ '22': daysAgo(9) });
  signIn({ kind: 'owner', name: 'Will Bradford', officeId: null });
  await call('loadAllFromSupabase');
  const racePatches = leadCalls('PATCH');
  assert.equal(racePatches.length, 1);
  assert.match(racePatches[0].url, /stage=eq\.quoted/);
  assert.deepEqual(racePatches[0].body, { stage: 'followup' });
  assert.equal(state.leads[0].stage, 'quoted');
  assert.equal(state.leads[0].notes, 'Still the original note');
  assert.equal(state.leads[0].phone, '333');
  assert.equal(state.leads[0].value, '4200');
  assert.equal(leadAudits().length, 0);
  const raceTimers = JSON.parse(state.settings.lead_quoted_dates);
  assert.equal(typeof raceTimers['22'], 'string');
  assert.ok(Date.now() - new Date(raceTimers['22']).getTime() >= 8 * 24 * 60 * 60 * 1000, 'a missed update does not clear the timer or restart it');
});

test('page load does not save costing settings unless the owner is seeding a missing row', async () => {
  const sessions = [
    { kind: 'office', name: 'Grok – Ops Manager', officeId: 'ops1' },
    { kind: 'pm', name: 'PM - Helias', officeId: 'c7e1aa20' },
    { kind: 'agent', name: 'Agent – Survey', officeId: 'ag99' },
    { kind: 'owner', name: 'Will Bradford', officeId: null },
  ];
  for (const session of sessions) {
    resetNetwork();
    delete state.settings.costing_settings;
    signIn(session);
    const mark = calls.length;
    await call('loadAllFromSupabase');
    const writes = calls.slice(mark).filter(c => c.method === 'POST' && c.url.includes('/rest/v1/settings') && c.body && c.body.key === 'costing_settings');
    const audits = state.audit.filter(a => a && a.action === 'costing_settings_changed');
    if (session.kind === 'owner') {
      assert.equal(writes.length, 1, 'the owner still saves the first rate set when none is stored');
      assert.equal(audits.length, 1);
      assert.match(audits[0].details, /Starting rate sets saved/);
    } else {
      assert.equal(writes.length, 0, session.name + ' saved costing settings on load');
      assert.equal(audits.length, 0, session.name + ' filed costing_settings_changed');
      assert.equal(Object.prototype.hasOwnProperty.call(state.settings, 'costing_settings'), false);
    }
  }

  resetNetwork();
  signIn({ kind: 'owner', name: 'Will Bradford', officeId: null });
  const before = state.settings.costing_settings;
  const mark = calls.length;
  await call('loadAllFromSupabase');
  const writes = calls.slice(mark).filter(c => c.method === 'POST' && c.url.includes('/rest/v1/settings') && c.body && c.body.key === 'costing_settings');
  assert.equal(writes.length, 0, 'an owner load must not rewrite costing settings that are already saved');
  assert.equal(state.settings.costing_settings, before);
  assert.equal(state.audit.some(a => a && a.action === 'costing_settings_changed'), false);
});

test('an office load does not seed an empty mileage rate list', async () => {
  resetNetwork();
  delete state.settings.mileage_rates;
  signIn({ kind: 'office', name: 'Grok – Ops Manager', officeId: 'ops1' });
  await call('loadAllFromSupabase');
  assert.equal(settingsPosts('mileage_rates').length, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(state.settings, 'mileage_rates'), false);
});
