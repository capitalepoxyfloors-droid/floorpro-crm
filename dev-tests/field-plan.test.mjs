/**
 * Job overview, today's plan, and office daily checks. Synthetic jobs only.
 * Stop order is on-screen memory. These tests do not write to a database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const DAY = '2026-11-02';
const audits = [];
const patches = [];

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function mockFetch(url, opts = {}) {
  const u = String(url);
  let body = null;
  if (opts.body && typeof opts.body === 'string') {
    try { body = JSON.parse(opts.body); } catch { body = opts.body; }
  }
  if (u.includes('/rest/v1/audit_log') && String(opts.method).toUpperCase() === 'POST') audits.push(body);
  if (u.includes('/rest/v1/rpc/fp_patch_job_records')) {
    patches.push(body);
    const sent = body && body.patches && body.patches[0];
    return Promise.resolve(jsonResponse({ ok: true, jobs: [{ id: sent && sent.id, updated_at: '2026-11-07T18:00:00.000Z' }] }));
  }
  if (u.includes('/auth/v1/token')) return Promise.resolve(jsonResponse({ access_token: 'access-office', refresh_token: 'refresh-office', expires_in: 3600 }));
  if (u.includes('/functions/v1/pin-admin')) return Promise.resolve(jsonResponse({ kind: 'office', display_name: 'Ops Reviewer', office_id: 'ops' }));
  if (String(opts.method || 'GET').toUpperCase() === 'GET') return Promise.resolve(jsonResponse([]));
  return Promise.resolve(jsonResponse([{ id: 1 }]));
}

let w;
function ev(src) { return w.eval(src); }
function call(name, ...args) {
  w.__fpArgs = args;
  return w.eval(name + '.apply(undefined, window.__fpArgs)');
}

test.before(async () => {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1/?env=test',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = mockFetch;
      window.AbortController = AbortController;
      window.confirm = () => true;
      const origInterval = window.setInterval.bind(window);
      window.setInterval = (fn, ms, ...args) => (ms >= 500 ? 0 : origInterval(fn, ms, ...args));
      window.CSS = window.CSS || { escape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); } };
    },
  });
  w = dom.window;
  await new Promise(r => setTimeout(r, 40));
  ev(`CREW_DATA.forEach((c,i)=>{ if(!c) return; c.hourly=''; c.name=['Avery','Blake','Casey'][i]||c.name; c.full=['Avery Cole','Blake Nguyen','Casey Ortiz'][i]||c.full; });`);
  ev(`CREW.forEach((c,i)=>{ if(!c) return; c.name=CREW_DATA[i].name; c.full=CREW_DATA[i].full; });`);
  w.localStorage.setItem('fpOfficeUser', 'Ops Reviewer');
  w.localStorage.removeItem('fpRole');
  ev("_fpTodayOverride='2026-11-02'; _fpChecksDate='2026-11-02'; cvCrewIdx=0;");
});
function seed() {
  const jobs = [
    { id: 'north', customer: 'North Warehouse', scope: 'Grind and prime the main floor.', jobType: 'flake-good', startDate: DAY, endDate: DAY, value: '18500', dayLogs: { [DAY]: { notes: '', task: '', startTime: '7:50 AM', endTime: '3:10 PM', fullDay: true, crewPresent: [{ name: 'Avery Cole', crewIdx: 0 }] } } },
    { id: 'east', customer: 'East Hall', scope: '', jobType: 'epoxy', startDate: DAY, endDate: DAY, value: '9000', dayLogs: { [DAY]: { notes: 'Coat is down.', task: 'Topcoat', startTime: '8:00 AM', endTime: '9:00 AM', crewPresent: [{ name: 'Blake Nguyen', crewIdx: 1 }] } } },
    { id: 'south', customer: 'South Bay', scope: '', jobType: 'epoxy', startDate: '2026-11-03', endDate: '2026-11-03', extraDays: [DAY], value: '', dayLogs: { [DAY]: { notes: '', task: '', startTime: '1:00 PM', endTime: '2:00 PM', crewPresent: [] } } },
    { id: 'west', customer: 'West Lot', scope: '', jobType: 'epoxy', startDate: '2026-11-09', endDate: '2026-11-09', value: '', dayLogs: { [DAY]: { notes: 'Came back for a repair.', task: 'Repair', startTime: '4:00 PM', endTime: '5:00 PM', crewPresent: [{ name: 'Casey Ortiz', crewIdx: 2 }] } } },
  ];
  w.__jobs = jobs;
  ev('JOB_RECORDS.splice(0, JOB_RECORDS.length, ...window.__jobs)');
  ev('Object.keys(newSlots).forEach(k=>delete newSlots[k]); Object.keys(multiSlots).forEach(k=>delete multiSlots[k]); Object.keys(SLOT_JOB_MAP).forEach(k=>delete SLOT_JOB_MAP[k]); Object.keys(ptoSlots).forEach(k=>delete ptoSlots[k]); Object.keys(_fpStopOrder).forEach(k=>delete _fpStopOrder[k]);');
  const pos = call('seDateToPos', DAY);
  ev(`newSlots[0]={}; newSlots[0][${pos.w}]={}; newSlots[0][${pos.w}][${pos.d}]={l:'North Warehouse', t:'epoxy'};`);
  ev(`SLOT_JOB_MAP['0_${pos.w}_${pos.d}']='north';`);
  ev(`multiSlots['0_${pos.w}_${pos.d}']=[${JSON.stringify({ l: 'East Hall', t: 'epoxy', jobId: 'east' })}];`);
  ev(`ptoSlots[0]={}; ptoSlots[0][${pos.w}]={}; ptoSlots[0][${pos.w}][${pos.d}]={label:'sick leave', type:'pto'};`);
  ev(`newSlots[1]={}; newSlots[1][${pos.w}]={}; newSlots[1][${pos.w}][${pos.d}]={l:'South Bay', t:'epoxy'};`);
  ev(`SLOT_JOB_MAP['1_${pos.w}_${pos.d}']='south';`);
}

test('the job overview uses stored scope and does not invent color, access, or an approval', () => {
  seed();
  call('openJobCard', 'north');
  call('jcTab', 'log');
  const text = w.document.getElementById('fp-job-overview').textContent;
  assert.match(text, /Grind and prime the main floor/);
  assert.match(text, /Epoxy Flake — Good/);
  assert.match(text, /Not reviewed/);
  assert.match(text, /Color: Not specified/);
  assert.match(text, /Access: Not specified/);
  assert.match(text, /Critical notes: Not specified/);
  assert.match(text, /Epoxy Base/);
  assert.equal(text.includes('150'), false);
  assert.equal(text.includes('18500'), false);
  assert.equal(text.includes('$'), false);
  call('openJobCard', 'east');
  call('jcTab', 'log');
  const plain = w.document.getElementById('fp-job-overview').textContent;
  assert.match(plain, /System: Not specified/);
  assert.match(plain, /Scope: Not specified/);
  assert.equal(plain.includes('Technical details'), false);
  assert.equal(plain.includes('9000'), false);
});

test('today’s plan numbers the stops, keeps a move on screen only, and hides the PTO reason', () => {
  seed();
  ev('cvCrewIdx=0;');
  call('_fpPaintTodayPlan');
  const host = w.document.getElementById('cv-today-plan');
  const labels = [...host.querySelectorAll('.fp-plan-open')].map(el => el.textContent);
  assert.equal(labels[0].startsWith('First stop'), true);
  assert.equal(labels.some(t => t.includes('Next stop')), true);
  assert.equal(labels.some(t => t.includes('PTO')), true);
  assert.equal(host.textContent.includes('sick'), false);
  assert.match(host.textContent, /not saved/);
  const before = labels.join('|');
  host.querySelector('.fp-plan-move').click();
  const after = [...host.querySelectorAll('.fp-plan-open')].map(el => el.textContent).join('|');
  assert.notEqual(after, before);
  assert.equal(w.localStorage.getItem('fpStopOrder'), null);
  w.document.body.classList.add('crew-mode');
  w.localStorage.setItem('fpRole', 'crew');
  call('_fpPaintTodayPlan');
  assert.equal(host.querySelector('.fp-plan-move'), null);
  assert.equal(host.textContent.includes('sick'), false);
  w.document.body.classList.remove('crew-mode');
  w.localStorage.removeItem('fpRole');
});

test('daily checks cover the other job, a short clock, a missing name, and a renamed slot', () => {
  seed();
  const pos = call('seDateToPos', DAY);
  ev(`newSlots[0][${pos.w}][${pos.d}].l='North Shop';`);
  const report = call('_fpDailyChecks', DAY);
  const missing = [...report.missing.map(r => r.customer)].sort();
  assert.equal(JSON.stringify(missing), JSON.stringify(['North Warehouse', 'South Bay']));
  assert.equal(report.missing.some(r => r.customer === 'East Hall'), false);
  assert.equal(report.missing.some(r => r.customer === 'West Lot'), false);
  assert.equal(report.time.some(r => r.customer === 'East Hall'), false);
  assert.equal(report.time.some(r => /Who worked South Bay/.test(r.text)), true);
  assert.equal(report.time.some(r => r.customer === 'North Warehouse'), false);
  assert.equal(report.details.some(r => r.text.includes('North Shop') && r.text.includes('North Warehouse')), true);
  assert.equal(JSON.stringify(report).includes('18500'), false);
  assert.equal(JSON.stringify(report).includes('9000'), false);
  call('_fpPaintDailyChecks');
  const checks = w.document.getElementById('fp-daily-checks').textContent;
  assert.match(checks, /Missing job updates/);
  assert.match(checks, /Time to review/);
  assert.match(checks, /Job details to review/);
  w.document.body.classList.add('crew-mode');
  call('_fpPaintDailyChecks');
  assert.equal(w.document.getElementById('fp-daily-checks').textContent, '');
  w.document.body.classList.remove('crew-mode');
});

test('a suggested name is added only when tapped, and no work keeps the clocks', async () => {
  seed();
  const before = patches.length;
  call('openJobCard', 'south');
  call('jcTab', 'log');
  const prompt = w.document.getElementById('jc-day-logs').textContent;
  assert.match(prompt, /Who worked this/);
  assert.equal(ev(`JOB_RECORDS.find(j=>j.id==='south').dayLogs['${DAY}'].crewPresent.some(c=>c.name)`), false);
  const chip = [...w.document.querySelectorAll('#jc-day-logs button')].find(b => b.textContent === 'Blake Nguyen');
  assert.ok(chip);
  chip.click();
  assert.equal(ev(`JOB_RECORDS.find(j=>j.id==='south').dayLogs['${DAY}'].crewPresent.some(c=>c.name==='Blake Nguyen')`), true);
  assert.equal(patches.length, before);
  assert.match([...w.document.querySelectorAll('[data-jc-save-status]')].map(el => el.textContent).join(' '), /Unsaved changes/);
  call('openJobCard', 'north');
  call('jcTab', 'log');
  const clocks = ev(`JOB_RECORDS.find(j=>j.id==='north').dayLogs['${DAY}'].startTime`);
  w.confirm = () => false;
  call('jcToggleNoWork', DAY);
  assert.equal(ev(`JOB_RECORDS.find(j=>j.id==='north').dayLogs['${DAY}'].noWork`), undefined);
  assert.equal(ev(`JOB_RECORDS.find(j=>j.id==='north').dayLogs['${DAY}'].startTime`), clocks);
  w.confirm = () => true;
  audits.length = 0;
  call('jcToggleNoWork', DAY);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(ev(`!!JOB_RECORDS.find(j=>j.id==='north').dayLogs['${DAY}'].noWork`), true);
  assert.equal(ev(`JOB_RECORDS.find(j=>j.id==='north').dayLogs['${DAY}'].startTime`), clocks);
  assert.equal(audits.some(a => a && a.action === 'no_work' && String(a.details).includes(DAY)), true);
});
