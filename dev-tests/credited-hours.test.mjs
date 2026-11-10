/**
 * Per-person credited hours. Fake people and jobs only. No live network.
 * Counted time stays on the existing 0.1h clock steps. 6h 10m counts as 6.2h.
 * A 1.8h credit plus that 6.2h is an exact 8.0h day. 1h 50m is 1.8333h and is not stored as 8.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const DAY = '2026-06-23';

const state = { settings: {}, audit: [], rpcBodies: [] };

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function mockFetch(url, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const u = String(url);
  let body = null;
  if (opts.body && typeof opts.body === 'string') {
    try { body = JSON.parse(opts.body); } catch { body = opts.body; }
  }
  if (u.includes('/rest/v1/rpc/')) {
    state.rpcBodies.push({ url: u, body });
    if (u.includes('fp_patch_job_records')) {
      return Promise.resolve(jsonResponse({ code: 'PGRST202', message: 'Could not find the function public.fp_patch_job_records(patches) in the schema cache' }, 404));
    }
    return Promise.resolve(jsonResponse({ ok: true, jobs: [] }));
  }
  if (u.includes('/rest/v1/settings')) {
    if (method === 'GET') {
      const m = u.match(/key=eq\.([^&]+)/);
      const key = m ? decodeURIComponent(m[1]) : '';
      if (Object.prototype.hasOwnProperty.call(state.settings, key)) {
        return Promise.resolve(jsonResponse([{ key, value: state.settings[key] }]));
      }
      return Promise.resolve(jsonResponse([]));
    }
    if (method === 'POST' && body && body.key) {
      state.settings[body.key] = body.value;
      return Promise.resolve(jsonResponse([body]));
    }
  }
  if (u.includes('/rest/v1/audit_log') && method === 'POST') {
    state.audit.push(body);
    return Promise.resolve(jsonResponse([{ id: state.audit.length }]));
  }
  if (method === 'GET') return Promise.resolve(jsonResponse([]));
  if (method === 'POST') return Promise.resolve(jsonResponse([{ id: 1 }]));
  return Promise.resolve(new Response(null, { status: 204 }));
}

let dom;
let w;
const ev = (src) => w.eval(src);
const plain = (v) => JSON.parse(JSON.stringify(v));
function call(name, ...args) {
  w.__fpArgs = args;
  return w.eval(name + '.apply(undefined, window.__fpArgs)');
}

const FAKE = [
  ['Avery', 'Avery Cole'],
  ['Blake', 'Blake Diaz'],
  ['Casey', 'Casey Ng'],
  ['Drew', 'Drew Patel'],
  ['Eden', 'Eden Brooks'],
];

function useFakeCrew() {
  FAKE.forEach(([first, full], i) => {
    ev(`CREW_DATA[${i}].name=${JSON.stringify(first)}; CREW_DATA[${i}].full=${JSON.stringify(full)}; CREW_DATA[${i}].hourly='';`);
    ev(`if(CREW[${i}]){ CREW[${i}].name=${JSON.stringify(first)}; CREW[${i}].full=${JSON.stringify(full)}; }`);
  });
  w.localStorage.setItem('fpOfficeUser', 'Ops Reviewer');
  w.localStorage.removeItem('fpRole');
  if (typeof w.jcCloseHourAdjust === 'function') w.jcCloseHourAdjust();
}

function row(idx, start, end) {
  return { crewIdx: idx, name: FAKE[idx][1], startTime: start, endTime: end };
}

function putJobs(jobs) {
  w.__jobs = JSON.parse(JSON.stringify(jobs));
  w.eval('JOB_RECORDS.splice(0, JOB_RECORDS.length, ...window.__jobs)');
}
function J() { return w.eval('JOB_RECORDS'); }
function setBaseline(jobs) {
  w.__baseJobs = JSON.parse(JSON.stringify(jobs));
  w.eval('_jrBaseline = window.__baseJobs');
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
      window.confirm = () => true;
      window.CSS = window.CSS || { escape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); } };
    },
  });
  w = dom.window;
  await new Promise(r => setTimeout(r, 40));
  w.__realSave = w.saveJobRecords.bind(w);
  w.saveJobRecords = () => Promise.resolve(true);
});
test.after(() => { if (w) w.close(); });

test('clock rounding is unchanged and 1h 50m is not an 8.0h day', () => {
  useFakeCrew();
  assert.equal(call('jcCalcHrs', '7:50 AM', '3:10 PM'), '7.3 hrs');
  assert.equal(call('jcCalcHrs', '9:00 AM', '3:10 PM'), '6.2 hrs');
  assert.equal(call('jcCalcHrs', '7:45 AM', '8:15 AM'), '0.5 hrs');
  assert.equal(call('jcLegacyTenths', 6.2), 62);
  assert.equal(call('jcLegacyTenths', 7.3), 73);
  assert.equal(call('jcLegacyTenths', 0.5), 5);
  assert.equal(call('jcParseCreditTenths', '1.8'), 18);
  assert.equal(call('jcParseCreditTenths', '8.0'), 80);
  assert.equal(call('jcParseCreditTenths', '1.83'), null);
  assert.equal(call('jcParseCreditMinutes', '1:50'), 110);
  const explained = plain(call('jcExplainMinuteCredit', 110, 62));
  assert.equal(explained.isTenth, false);
  assert.equal(explained.lowerTenths, 18);
  assert.equal(explained.upperTenths, 19);
  assert.equal(explained.dayTenthsIfLower, 80);
  assert.equal(explained.dayTenthsIfUpper, 81);
  assert.ok(Math.abs(explained.dayHoursIfExact - 8.0333) < 0.0001);
  assert.ok(Math.abs(explained.exactHours - (110 / 60)) < 1e-12);
  assert.ok(Math.abs(explained.dayHoursIfExact - 8) > 0.03);
  // Rounding 8.0333h to the nearest tenth looks like 8.0. The day total must not do that.
  assert.equal(Math.round(explained.dayHoursIfExact * 10) / 10, 8);
  assert.equal(explained.dayTenthsIfLower, 80);
});

test('target day is exactly 8.0h in tenths while clocks and the 6.2h job stay put', () => {
  useFakeCrew();
  const harbor = {
    id: 'harbor', customer: 'Harbor Hall', status: 'in_progress',
    startDate: DAY, endDate: DAY,
    dayLogs: {
      [DAY]: {
        startTime: '9:00 AM', endTime: '3:10 PM',
        crewPresent: [
          row(0, '7:50 AM', '3:10 PM'),
          row(1, '9:00 AM', '3:10 PM'),
          row(2, '9:00 AM', '3:10 PM'),
        ],
      },
    },
  };
  const ridge = {
    id: 'ridge', customer: 'Ridge Hall', status: 'in_progress',
    startDate: DAY, endDate: DAY,
    dayLogs: {
      [DAY]: {
        startTime: '7:45 AM', endTime: '8:15 AM',
        crewPresent: [row(1, '7:45 AM', '8:15 AM'), row(2, '7:45 AM', '8:15 AM')],
      },
    },
  };
  putJobs([harbor, ridge]);
  ev(`_jcId='harbor'`);
  const avery = call('jcSetHourCredit', DAY, 0, { creditedTenths: 80, reason: 'Count the short clock as a full day' });
  assert.equal(avery.ok, true);
  ev(`_jcId='ridge'`);
  const blake = call('jcBalanceHourCredit', DAY, 0, 'Bring the counted day to 8.0h');
  const casey = call('jcBalanceHourCredit', DAY, 1, 'Bring the counted day to 8.0h');
  assert.equal(blake.ok, true);
  assert.equal(casey.ok, true);

  const jobs = plain(J());
  const hLog = jobs[0].dayLogs[DAY];
  const rLog = jobs[1].dayLogs[DAY];
  assert.equal(hLog.crewPresent[0].startTime, '7:50 AM');
  assert.equal(hLog.crewPresent[0].endTime, '3:10 PM');
  assert.equal(hLog.crewPresent[1].startTime, '9:00 AM');
  assert.equal(hLog.crewPresent[1].endTime, '3:10 PM');
  assert.equal(rLog.crewPresent[0].startTime, '7:45 AM');
  assert.equal(rLog.crewPresent[0].endTime, '8:15 AM');
  assert.equal(hLog.hourAdjustments.length, 1);
  assert.equal(hLog.hourAdjustments[0].creditedTenths, 80);
  assert.equal(hLog.hourAdjustments[0].by, 'Ops Reviewer');
  assert.ok(hLog.hourAdjustments[0].at);
  assert.equal(rLog.hourAdjustments[0].creditedTenths, 18);
  assert.equal(rLog.hourAdjustments[0].balance.otherJobsTenths, 62);
  assert.equal(rLog.hourAdjustments[1].creditedTenths, 18);
  assert.equal(rLog.hourAdjustments[0].requestedMinutes, undefined);

  const hLines = plain(call('jcJobCostLines', J()[0], 'recorded'));
  const rLines = plain(call('jcJobCostLines', J()[1], 'recorded'));
  const hBy = Object.fromEntries(hLines.laborRows.map(r => [r.name, r]));
  const rBy = Object.fromEntries(rLines.laborRows.map(r => [r.name, r]));
  assert.equal(hBy['Avery Cole'].hrs, 8);
  assert.equal(hBy['Avery Cole'].tenths, 80);
  assert.equal(hBy['Avery Cole'].clockTenths, 73);
  assert.equal(hBy['Blake Diaz'].hrs, 6.2);
  assert.equal(hBy['Blake Diaz'].tenths, 62);
  assert.equal(hBy['Blake Diaz'].credited, false);
  assert.equal(hBy['Casey Ng'].tenths, 62);
  assert.equal(rBy['Blake Diaz'].hrs, 1.8);
  assert.equal(rBy['Blake Diaz'].tenths, 18);
  assert.equal(rBy['Blake Diaz'].clockTenths, 5);
  assert.equal(rBy['Casey Ng'].tenths, 18);
  assert.equal(hBy['Blake Diaz'].hrs, plain(call('jcCalcHrs', '9:00 AM', '3:10 PM')).replace(' hrs', '') * 1);

  ev('_payrollPeriodOffset=0');
  const pay = plain(call('_payrollCompute', 0));
  for (const name of ['Avery Cole', 'Blake Diaz', 'Casey Ng']) {
    const person = pay.rows.find(r => r.label === name);
    assert.ok(person, name);
    const day = person.days.filter(d => d.date === DAY);
    const tenths = day.reduce((s, d) => s + d.tenths, 0);
    assert.equal(tenths, 80, name + ' day tenths');
    assert.equal(person.regHrs, 8);
  }
  const blakePay = pay.rows.find(r => r.label === 'Blake Diaz');
  const blakeHarbor = blakePay.days.find(d => d.job === 'Harbor Hall');
  const blakeRidge = blakePay.days.find(d => d.job === 'Ridge Hall');
  assert.equal(blakeHarbor.hrs, hBy['Blake Diaz'].hrs);
  assert.equal(blakeRidge.hrs, rBy['Blake Diaz'].hrs);
  assert.equal(blakeHarbor.credited, false);
  assert.equal(blakeRidge.credited, true);
  assert.equal(blakeHarbor.tenths + blakeRidge.tenths, 80);

  ev(`_jcId='ridge'`);
  const refused = call('jcSetHourCredit', DAY, 0, { creditedTenths: 11, reason: 'not a neighbor', requestedMinutes: 110, otherTenths: 62 });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'not-a-tenth-choice');
  const chosen = call('jcSetHourCredit', DAY, 0, { creditedTenths: 18, reason: 'Chose 1.8h after typing 1:50', requestedMinutes: 110, otherTenths: 62 });
  assert.equal(chosen.ok, true);
  assert.equal(J()[1].dayLogs[DAY].hourAdjustments[0].creditedTenths, 18);
  assert.equal(J()[1].dayLogs[DAY].hourAdjustments[0].requestedMinutes, 110);
  assert.equal(J()[1].dayLogs[DAY].crewPresent[0].endTime, '8:15 AM');
});

test('split shifts, full day, no work, and one person do not spill onto the others', () => {
  useFakeCrew();
  const split = {
    id: 'split', customer: 'Split Hall', startDate: DAY, endDate: DAY,
    dayLogs: {
      [DAY]: {
        crewPresent: [
          row(0, '8:00 AM', '12:00 PM'),
          row(0, '1:00 PM', '4:00 PM'),
          row(1, '8:00 AM', '4:00 PM'),
        ],
      },
    },
  };
  putJobs([split]);
  ev(`_jcId='split'`);
  let lines = plain(call('jcJobCostLines', J()[0], 'recorded'));
  assert.equal(lines.laborRows.find(r => r.name === 'Avery Cole').hrs, 7);
  assert.equal(lines.laborRows.find(r => r.name === 'Blake Diaz').hrs, 8);
  call('jcSetHourCredit', DAY, 0, { creditedTenths: 80, reason: 'Count the split as 8.0h' });
  lines = plain(call('jcJobCostLines', J()[0], 'recorded'));
  const avery = lines.laborRows.find(r => r.name === 'Avery Cole');
  const blake = lines.laborRows.find(r => r.name === 'Blake Diaz');
  assert.equal(avery.tenths, 80);
  assert.equal(avery.clockTenths, 70);
  assert.equal(lines.laborRows.filter(r => r.name === 'Avery Cole').length, 1);
  assert.equal(blake.tenths, 80);
  assert.equal(blake.credited, false);
  assert.equal(J()[0].dayLogs[DAY].crewPresent[0].startTime, '8:00 AM');
  assert.equal(J()[0].dayLogs[DAY].crewPresent[1].endTime, '4:00 PM');

  J()[0].dayLogs[DAY].fullDay = true;
  call('jcClearHourCredit', DAY, 0);
  lines = plain(call('jcJobCostLines', J()[0], 'recorded'));
  assert.equal(lines.laborRows.find(r => r.name === 'Avery Cole').tenths, 80);
  assert.equal(lines.hours, 16);

  call('jcSetHourCredit', DAY, 2, { creditedTenths: 60, reason: 'Blake only, not the full-day flag' });
  lines = plain(call('jcJobCostLines', J()[0], 'recorded'));
  assert.equal(lines.laborRows.find(r => r.name === 'Avery Cole').tenths, 80);
  assert.equal(lines.laborRows.find(r => r.name === 'Blake Diaz').tenths, 60);
  assert.equal(lines.laborRows.find(r => r.name === 'Avery Cole').source, undefined);

  J()[0].dayLogs[DAY].noWork = true;
  lines = plain(call('jcJobCostLines', J()[0], 'recorded'));
  assert.equal(lines.laborRows.length, 0);
  assert.equal(lines.hours, 0);
  ev('_payrollPeriodOffset=0');
  const pay = plain(call('_payrollCompute', 0));
  assert.equal(pay.rows.some(r => (r.days || []).some(d => d.date === DAY && d.job === 'Split Hall')), false);
  assert.equal(J()[0].dayLogs[DAY].hourAdjustments[0].creditedTenths, 60);
  assert.equal(J()[0].dayLogs[DAY].crewPresent[2].startTime, '8:00 AM');
});

test('old logs without a credit match the previous hour rules', () => {
  useFakeCrew();
  const old = {
    id: 'old', customer: 'Old Hall', startDate: DAY, endDate: DAY,
    dayLogs: {
      [DAY]: {
        fullDay: true,
        crewPresent: [
          { crewIdx: 0, name: 'Avery Cole' },
          { crewIdx: 0, name: 'Avery Cole' },
          { crewIdx: 1, name: 'Blake Diaz' },
        ],
      },
    },
  };
  putJobs([old]);
  let lines = plain(call('jcJobCostLines', J()[0], 'recorded'));
  assert.equal(lines.laborRows.find(r => r.name === 'Avery Cole').hrs, 8);
  assert.equal(lines.laborRows.find(r => r.name === 'Blake Diaz').hrs, 8);
  assert.equal(lines.hours, 16);
  J()[0].dayLogs[DAY].fullDay = false;
  J()[0].dayLogs[DAY].startTime = '9:00 AM';
  J()[0].dayLogs[DAY].endTime = '3:10 PM';
  J()[0].dayLogs[DAY].crewPresent = [row(1, '', '')];
  lines = plain(call('jcJobCostLines', J()[0], 'recorded'));
  assert.equal(lines.laborRows[0].hrs, parseFloat(call('jcCalcHrs', '9:00 AM', '3:10 PM')));
  assert.equal(lines.laborRows[0].tenths, 62);
  J()[0].dayLogs[DAY].hourAdjustments = [{ crewIdx: 1, name: 'Blake Diaz', creditedTenths: 18.5, reason: 'bad' }];
  lines = plain(call('jcJobCostLines', J()[0], 'recorded'));
  assert.equal(lines.laborRows[0].tenths, 62);
});

test('a credit needs a reason and an office session, and the audit names the credit', () => {
  useFakeCrew();
  putJobs([{
    id: 'audit', customer: 'Audit Hall', startDate: DAY, endDate: DAY,
    dayLogs: { [DAY]: { crewPresent: [row(0, '7:50 AM', '3:10 PM')] } },
  }]);
  ev(`_jcId='audit'`);
  const before = plain(J()[0].dayLogs);
  assert.equal(call('jcSetHourCredit', DAY, 0, { creditedTenths: 80, reason: '   ' }).ok, false);
  assert.equal(J()[0].dayLogs[DAY].hourAdjustments, undefined);
  w.localStorage.setItem('fpRole', 'crew');
  assert.equal(call('jcSetHourCredit', DAY, 0, { creditedTenths: 80, reason: 'crew attempt' }).error, 'office-only');
  assert.equal(J()[0].dayLogs[DAY].hourAdjustments, undefined);
  w.localStorage.removeItem('fpRole');
  assert.equal(call('jcSetHourCredit', DAY, 0, { creditedTenths: 80, reason: 'Count the short clock as a full day' }).ok, true);
  const diff = plain(call('_jrDiffDayLogs', before, J()[0].dayLogs));
  const credit = diff.find(d => d.label.startsWith('Credited hours'));
  assert.ok(credit);
  assert.match(credit.to, /Avery Cole credited 8\.0h/);
  assert.match(credit.to, /Count the short clock as a full day/);
  assert.match(credit.to, /Ops Reviewer/);
  assert.equal(diff.some(d => d.label.startsWith('Start Time') || d.label.startsWith('End Time')), false);
  const officeCard = call('jcDayCrewHtml', DAY, J()[0].dayLogs[DAY]);
  assert.match(officeCard, /7:50 AM/);
  assert.match(officeCard, /7\.3 hrs/);
  assert.match(officeCard, /Credited 8\.0 hrs/);
  assert.match(officeCard, /Use site time/);
  assert.doesNotMatch(officeCard, /8\.0333|0\.1h step|is not |Explain, don't save|Check an exact duration|Use lower 0\.1h/);
  assert.doesNotMatch(officeCard, /7:50 AM – 3:10 PM \(8/);
  w.localStorage.setItem('fpRole', 'crew');
  const crewHtml = call('jcDayCrewHtml', DAY, J()[0].dayLogs[DAY]);
  assert.equal(crewHtml.includes('Save credit'), false);
  assert.equal(crewHtml.includes('Balance today'), false);
  assert.equal(crewHtml.includes('1.8333'), false);
  assert.equal(crewHtml.includes('Reason'), false);
  assert.equal(crewHtml.includes('Hours'), false);
  assert.equal(crewHtml.includes('7.3 hrs'), false);
  assert.equal(crewHtml.includes('Credited'), false);
  assert.match(crewHtml, /7:50 AM/);
  assert.match(crewHtml, /3:10 PM/);
  assert.match(crewHtml, /Use site time/);
});

test('a crew row uses the site clock and does not say the row has no clock', () => {
  useFakeCrew();
  const person = { crewIdx: 1, name: 'Blake Diaz' };
  const site = { startTime: '7:30 AM', endTime: '3:30 PM', task: 'Prime the floor', crewPresent: [person] };
  assert.equal(call('jcLogHasCountedTime', site), true);
  assert.equal(call('jcClockHrsForRow', person, site), 8);
  const crew = call('jcHourCreditHtml', DAY, 0, person, site, true);
  assert.equal(crew, '');
  assert.equal(crew.includes('No clock on this row'), false);
  assert.equal(crew.includes('Balance today'), false);
  assert.equal(crew.includes('Explain'), false);
  assert.equal(crew.includes('Hours'), false);
  const credited = {
    startTime: '7:30 AM', endTime: '3:30 PM', task: 'Prime the floor', crewPresent: [person],
    hourAdjustments: [{ crewIdx: 1, name: 'Blake Diaz', creditedTenths: 18, reason: 'Office only', by: 'Ops Reviewer' }],
  };
  const withCredit = call('jcHourCreditHtml', DAY, 0, person, credited, true);
  assert.equal(withCredit, '');
  assert.equal(withCredit.includes('Hours'), false);
  assert.equal(withCredit.includes('1.8'), false);
  assert.equal(withCredit.includes('Credited'), false);
  assert.equal(credited.hourAdjustments[0].creditedTenths, 18);
  assert.equal(credited.startTime, '7:30 AM');
  assert.equal(credited.endTime, '3:30 PM');
  const office = call('jcHourCreditHtml', DAY, 0, person, credited, false);
  assert.match(office, /Adjust hours/);
  assert.match(office, /Credited 1\.8 hrs/);
  assert.equal(office.includes('Balance today'), false);
  assert.equal(office.includes('>Save<'), false);
  assert.equal(office.includes('No clock on this row'), false);
  assert.equal(office.includes('0.1h'), false);
  call('jcSetHourAdjustOpen', DAY, 0, true);
  const officeOpen = call('jcHourCreditHtml', DAY, 0, person, credited, false);
  assert.match(officeOpen, /Balance today to 8\.0h/);
  assert.match(officeOpen, />Save</);
  assert.match(officeOpen, /Credited hours/);
  assert.equal(officeOpen.includes('Explain'), false);
  assert.equal(officeOpen.includes('0.1h'), false);
  assert.equal(officeOpen.includes('8.0333'), false);
  call('jcSetHourAdjustOpen', DAY, 0, false);
  const empty = { task: 'Prime the floor', crewPresent: [person] };
  assert.equal(call('jcLogHasCountedTime', empty), false);
  assert.equal(call('jcHourCreditHtml', DAY, 0, person, empty, true), '');
});

test('a half-entered site clock is not a stored 1.8 credit', () => {
  useFakeCrew();
  w.localStorage.setItem('fpRole', 'crew');
  const person = { crewIdx: 1, name: 'Blake Diaz', startTime: '', endTime: '' };
  const partial = { startTime: '7:30 AM', endTime: '', task: 'Scrape', crewPresent: [person] };
  assert.equal(call('jcLogHasCountedTime', partial), false);
  assert.equal(call('jcClockHrsForRow', person, partial), 0);
  const office = call('jcHourCreditHtml', DAY, 0, person, partial, false);
  assert.equal(office.includes('No clock on this row'), false);
  assert.equal(office.includes('Counted 0.0h'), false);
  assert.equal(office.includes('value="1.8"'), false);
  assert.equal(office.includes('1.8'), false);
  call('jcSetHourAdjustOpen', DAY, 0, true);
  const officeOpen = call('jcHourCreditHtml', DAY, 0, person, partial, false);
  assert.match(officeOpen, /Credited hours/);
  assert.equal(officeOpen.includes('value="1.8"'), false);
  call('jcSetHourAdjustOpen', DAY, 0, false);
  const row = call('jcDayCrewHtml', DAY, partial);
  assert.match(row, /Set site time above/);
  assert.match(row, /Different time\?/);
  assert.equal(row.includes('Add both start and end'), false);
  assert.equal(row.includes('Hours'), false);
  const stored = {
    startTime: '7:30 AM', endTime: '', crewPresent: [person],
    hourAdjustments: [{ crewIdx: 1, name: 'Blake Diaz', creditedTenths: 18, reason: 'Office only', by: 'Ops Reviewer' }],
  };
  assert.equal(call('jcLogHasCountedTime', stored), true);
  const crewStored = call('jcHourCreditHtml', DAY, 0, person, stored, true);
  assert.equal(crewStored, '');
  assert.equal(crewStored.includes('Hours 1.8'), false);
  assert.equal(crewStored.includes('1.8'), false);
  assert.equal(crewStored.includes('Credited'), false);
  assert.equal(stored.hourAdjustments[0].creditedTenths, 18);
  assert.equal(stored.endTime, '');
});

test('a notes edit keeps a credit, and a credit edit keeps server notes', () => {
  useFakeCrew();
  const adjA = [{ crewIdx: 0, name: 'Avery Cole', creditedTenths: 80, reason: 'first', at: '2026-06-23T15:00:00.000Z', by: 'Ops Reviewer' }];
  const adjB = [{ crewIdx: 0, name: 'Avery Cole', creditedTenths: 75, reason: 'revised', at: '2026-06-23T16:00:00.000Z', by: 'Ops Reviewer' }];
  const base = { id: 'merge', dayLogs: { [DAY]: { notes: 'old', startTime: '7:50 AM', endTime: '3:10 PM', hourAdjustments: adjA, crewPresent: [row(0, '7:50 AM', '3:10 PM')] } } };
  const local = JSON.parse(JSON.stringify(base));
  local.dayLogs[DAY].notes = 'typed on this screen';
  const server = JSON.parse(JSON.stringify(base));
  server.dayLogs[DAY].hourAdjustments = adjB;
  J().splice(0, J().length, local);
  w.__baseJobs = [JSON.parse(JSON.stringify(base))];
  w.eval('_jrBaseline = window.__baseJobs');
  call('_mergeServerIntoLocal', [server]);
  assert.equal(J()[0].dayLogs[DAY].notes, 'typed on this screen');
  assert.equal(J()[0].dayLogs[DAY].hourAdjustments[0].creditedTenths, 75);
  assert.equal(J()[0].dayLogs[DAY].startTime, '7:50 AM');

  const base2 = JSON.parse(JSON.stringify(base));
  const local2 = JSON.parse(JSON.stringify(base));
  local2.dayLogs[DAY].hourAdjustments = [{ crewIdx: 0, name: 'Avery Cole', creditedTenths: 70, reason: 'ours', at: '2026-06-23T17:00:00.000Z', by: 'Ops Reviewer' }];
  const server2 = JSON.parse(JSON.stringify(base));
  server2.dayLogs[DAY].notes = 'note from the other screen';
  J().splice(0, J().length, local2);
  w.__baseJobs = [base2];
  w.eval('_jrBaseline = window.__baseJobs');
  call('_mergeServerIntoLocal', [server2]);
  assert.equal(J()[0].dayLogs[DAY].notes, 'note from the other screen');
  assert.equal(J()[0].dayLogs[DAY].hourAdjustments[0].creditedTenths, 70);
  assert.equal(J()[0].dayLogs[DAY].crewPresent[0].endTime, '3:10 PM');
});

test('a crew save cannot change a credit and does not send one back', async () => {
  useFakeCrew();
  const credit = [{ crewIdx: 0, name: 'Avery Cole', creditedTenths: 80, reason: 'office credit', at: '2026-06-23T15:00:00.000Z', by: 'Ops Reviewer' }];
  const job = {
    id: 'crew-job', customer: 'Crew Hall', startDate: DAY, endDate: DAY, updated_at: '2026-06-23T12:00:00.000Z',
    dayLogs: { [DAY]: { notes: 'old', startTime: '7:50 AM', endTime: '3:10 PM', hourAdjustments: credit, crewPresent: [row(0, '7:50 AM', '3:10 PM')] } },
  };
  putJobs([JSON.parse(JSON.stringify(job))]);
  setBaseline([job]);
  w.eval('_jobRecordsLoadOk = true');
  w.localStorage.setItem('fpRole', 'crew');
  J()[0].dayLogs[DAY].notes = 'crew note';
  J()[0].dayLogs[DAY].hourAdjustments = [{ crewIdx: 0, name: 'Avery Cole', creditedTenths: 10, reason: 'forged', at: '2026-06-23T18:00:00.000Z', by: 'Crew' }];
  J()[0].dayLogs[DAY].crewPresent[0].endTime = '4:00 PM';
  state.rpcBodies.length = 0;
  state.settings.job_records = JSON.stringify([job]);
  await w.__realSave();
  assert.equal(J()[0].dayLogs[DAY].hourAdjustments[0].creditedTenths, 80);
  assert.equal(J()[0].dayLogs[DAY].hourAdjustments[0].reason, 'office credit');
  assert.equal(J()[0].dayLogs[DAY].notes, 'crew note');
  const crewWrite = state.rpcBodies.find(c => c.url.includes('fp_crew_write_job_records'));
  assert.ok(crewWrite, 'crew write was sent');
  const payload = JSON.stringify(crewWrite.body);
  assert.equal(payload.includes('hourAdjustments'), false);
  assert.equal(payload.includes('forged'), false);
  assert.match(payload, /crew note/);
  assert.match(payload, /4:00 PM/);
});

function showEntry(id) {
  w.document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  w.document.getElementById('page-' + id).classList.add('active');
}
function creditEditor(html) {
  return html.includes('>Save<') && html.includes('Credited hours') && html.includes('Reason')
    && html.includes('Balance today to 8.0h')
    && !html.includes("Explain, don't save")
    && !html.includes('Use lower 0.1h')
    && !html.includes('Check an exact duration')
    && !html.includes('0.1h')
    && !html.includes('8.0333');
}
const CREW_CARD_LECTURE = /8\.0333|1\.8333|0\.1h step|is not |Explain, don't save|Check an exact duration|Use lower 0\.1h|Use higher 0\.1h|Credited hours use/;

test('office and owner can credit from the crew screen, and a crew sign-in cannot', () => {
  useFakeCrew();
  putJobs([{
    id: 'entry', customer: 'Entry Hall', startDate: DAY, endDate: DAY, value: '18500', displayVal: '$18,500', status: 'scheduled',
    dayLogs: { [DAY]: {
      startTime: '7:50 AM', endTime: '3:10 PM', overtimeWage: true, cashWages: false,
      crewPresent: [{ ...row(0, '7:50 AM', '3:10 PM'), burdenedRate: '41.50', directRate: '30.25', hourly: '30.25' }],
    } },
  }]);
  ev(`_jcId='entry'`);
  w.localStorage.setItem('fpOfficeUser', 'PM Salvation');
  w.localStorage.removeItem('fpRole');

  showEntry('jobs');
  let html = call('jcDayCrewHtml', DAY, J()[0].dayLogs[DAY]);
  assert.equal(html.includes('>Save<'), false);
  assert.match(html, /Adjust hours/);
  assert.doesNotMatch(html, CREW_CARD_LECTURE);
  call('jcSetHourAdjustOpen', DAY, 0, true);
  html = call('jcDayCrewHtml', DAY, J()[0].dayLogs[DAY]);
  assert.equal(creditEditor(html), true);
  call('jcSetHourAdjustOpen', DAY, 0, false);
  assert.equal(call('jcSetHourCredit', DAY, 0, { creditedTenths: 80, reason: 'From Jobs' }).ok, true);
  assert.equal(J()[0].dayLogs[DAY].crewPresent[0].startTime, '7:50 AM');
  assert.equal(J()[0].dayLogs[DAY].crewPresent[0].endTime, '3:10 PM');
  call('jcClearHourCredit', DAY, 0);

  showEntry('schedule');
  html = call('jcDayCrewHtml', DAY, J()[0].dayLogs[DAY]);
  assert.match(html, /Adjust hours/);
  assert.doesNotMatch(html, CREW_CARD_LECTURE);
  call('jcSetHourAdjustOpen', DAY, 0, true);
  assert.equal(creditEditor(call('jcDayCrewHtml', DAY, J()[0].dayLogs[DAY])), true);
  call('jcSetHourAdjustOpen', DAY, 0, false);
  assert.equal(call('jcSetHourCredit', DAY, 0, { creditedTenths: 80, reason: 'From Install' }).ok, true);
  call('jcClearHourCredit', DAY, 0);

  showEntry('crewview');
  html = call('jcDayCrewHtml', DAY, J()[0].dayLogs[DAY]);
  assert.match(html, /Adjust hours/);
  call('jcSetHourAdjustOpen', DAY, 0, true);
  html = call('jcDayCrewHtml', DAY, J()[0].dayLogs[DAY]);
  assert.equal(creditEditor(html), true, 'office on the Crew screen still gets the editor');
  call('jcSetHourAdjustOpen', DAY, 0, false);
  assert.equal(call('jcSetHourCredit', DAY, 0, { creditedTenths: 80, reason: 'From the crew screen' }).ok, true);
  assert.equal(J()[0].dayLogs[DAY].hourAdjustments[0].creditedTenths, 80);
  assert.equal(J()[0].dayLogs[DAY].hourAdjustments[0].reason, 'From the crew screen');
  assert.equal(J()[0].dayLogs[DAY].crewPresent[0].endTime, '3:10 PM');

  call('openJobCard', 'entry');
  call('jcTab', 'log');
  let rendered = w.document.getElementById('jc-day-logs').innerHTML;
  assert.match(rendered, /Adjust hours/);
  assert.doesNotMatch(rendered, CREW_CARD_LECTURE);
  assert.equal(rendered.includes('Pay for this day'), false);
  call('jcSetHourAdjustOpen', DAY, 0, true);
  rendered = w.document.getElementById('jc-day-logs').innerHTML;
  assert.equal(creditEditor(rendered), true);
  call('jcSetHourAdjustOpen', DAY, 0, false);
  assert.equal(rendered.includes('1.5× OT'), false);
  assert.equal(w.document.getElementById('jc-tab-costing').style.display, 'none');
  assert.equal(w.document.getElementById('jc-value-group').style.display, 'none');

  w.localStorage.removeItem('fpOfficeUser');
  assert.equal(call('jcSetHourCredit', DAY, 0, { creditedTenths: 75, reason: 'Owner from the crew screen' }).ok, true);
  assert.equal(J()[0].dayLogs[DAY].hourAdjustments[0].creditedTenths, 75);

  w.localStorage.setItem('fpRole', 'crew');
  w.document.body.classList.add('crew-mode');
  for (const route of ['crewview', 'jobs']) {
    showEntry(route);
    html = call('jcDayCrewHtml', DAY, J()[0].dayLogs[DAY]);
    assert.equal(html.includes('Save credit'), false, route);
    assert.equal(html.includes('>Save<'), false, route);
    assert.equal(html.includes('Adjust hours'), false, route);
    assert.equal(html.includes('Why the credit differs from the clock'), false, route);
    assert.doesNotMatch(html, CREW_CARD_LECTURE, route);
    assert.equal(html.includes('18500'), false, route);
    assert.equal(html.includes('41.50'), false, route);
    assert.equal(html.includes('30.25'), false, route);
    assert.equal(html.includes('Pay for this day'), false, route);
    assert.match(html, /7:50 AM/);
    call('openJobCard', 'entry');
    call('jcTab', 'log');
    const crewRendered = w.document.getElementById('jc-day-logs').innerHTML
      + w.document.getElementById('jc-value-group').outerHTML
      + w.document.getElementById('jc-pane-costing').innerHTML;
    assert.equal(crewRendered.includes('Save credit'), false, route);
    assert.equal(crewRendered.includes('Balance today'), false, route);
    assert.equal(crewRendered.includes('Use lower 0.1h'), false, route);
    assert.equal(crewRendered.includes('Adjust hours'), false, route);
    assert.doesNotMatch(crewRendered, CREW_CARD_LECTURE, route);
    assert.equal(crewRendered.includes('Hours'), false, route);
    assert.equal(crewRendered.includes('7.3 hrs'), false, route);
    assert.equal(crewRendered.includes('Credited'), false, route);
    assert.match(crewRendered, /7:50 AM/);
    assert.match(crewRendered, /3:10 PM/);
    assert.match(crewRendered, /Use site time/);
    assert.equal(crewRendered.includes('18500'), false, route);
    assert.equal(crewRendered.includes('41.50'), false, route);
    assert.equal(crewRendered.includes('30.25'), false, route);
    assert.equal(crewRendered.includes('Pay for this day'), false, route);
    assert.equal(w.document.getElementById('jc-tab-costing').style.display, 'none', route);
    assert.equal(w.document.getElementById('jc-value-group').style.display, 'none', route);
    assert.equal(w.document.getElementById('jc-value').value, '', route);
  }
  showEntry('crewview');
  call('showPage', 'jobs');
  assert.equal(w.document.getElementById('page-crewview').classList.contains('active'), true);
  assert.equal(w.document.getElementById('page-jobs').classList.contains('active'), false);
  assert.equal(call('jcSetHourCredit', DAY, 0, { creditedTenths: 10, reason: 'crew attempt' }).error, 'office-only');
  assert.equal(call('jcClearHourCredit', DAY, 0).error, 'office-only');
  assert.equal(J()[0].dayLogs[DAY].hourAdjustments[0].creditedTenths, 75);

  w.localStorage.removeItem('fpRole');
  showEntry('dashboard');
});

test('a daily log crew card shows the clock line and keeps the hours editor behind one link', () => {
  useFakeCrew();
  const site = {
    id: 'site', customer: 'North Shop', status: 'in_progress', startDate: DAY, endDate: DAY,
    dayLogs: {
      [DAY]: {
        startTime: '7:30 AM', endTime: '3:15 PM', task: 'Prime the floor',
        crewPresent: [
          { crewIdx: 0, name: 'Avery Cole' },
          { crewIdx: 1, name: 'Blake Diaz' },
        ],
      },
    },
  };
  const early = {
    id: 'early', customer: 'Early Hall', status: 'in_progress', startDate: DAY, endDate: DAY,
    dayLogs: {
      [DAY]: {
        startTime: '9:00 AM', endTime: '3:10 PM',
        crewPresent: [{ crewIdx: 0, name: 'Avery Cole', startTime: '9:00 AM', endTime: '3:10 PM' }],
      },
    },
  };
  putJobs([site, early]);
  ev(`_jcId='site'`);
  const log = J()[0].dayLogs[DAY];
  let html = call('jcDayCrewHtml', DAY, log);
  assert.match(html, /7:30 AM – 3:15 PM/);
  assert.match(html, /7\.8 hrs/);
  assert.match(html, /Different time\?/);
  assert.match(html, /Adjust hours/);
  assert.equal(html.includes('>Save<'), false);
  assert.equal(html.includes('Balance today'), false);
  assert.doesNotMatch(html, CREW_CARD_LECTURE);

  call('jcSetHourAdjustOpen', DAY, 0, true);
  html = call('jcDayCrewHtml', DAY, J()[0].dayLogs[DAY]);
  assert.equal(creditEditor(html), true);
  assert.doesNotMatch(html, CREW_CARD_LECTURE);
  assert.match(html, /Blake Diaz/);
  assert.match(html, /7\.8 hrs/);

  const holder = w.document.createElement('div');
  holder.innerHTML = html;
  w.document.body.appendChild(holder);
  call('jcPreviewDayBalance', DAY, 0);
  const input = w.document.getElementById('jcct-20260623-0');
  assert.equal(input.value, '1.8');
  const note = w.document.getElementById('jccn-20260623-0');
  assert.equal(note.textContent, '');
  assert.equal(J()[0].dayLogs[DAY].hourAdjustments, undefined);
  w.document.getElementById('jccr-20260623-0').value = 'Bring the day to 8.0';
  const saved = call('jcSaveHourCreditFromInputs', DAY, 0);
  assert.equal(saved.ok, true);
  assert.equal(J()[0].dayLogs[DAY].hourAdjustments[0].creditedTenths, 18);
  assert.equal(J()[0].dayLogs[DAY].hourAdjustments[0].balance.otherJobsTenths, 62);
  assert.equal(J()[0].dayLogs[DAY].startTime, '7:30 AM');
  assert.equal(J()[0].dayLogs[DAY].endTime, '3:15 PM');
  assert.equal(J()[1].dayLogs[DAY].crewPresent[0].endTime, '3:10 PM');
  assert.equal(J()[1].dayLogs[DAY].hourAdjustments, undefined);
  const closed = call('jcDayCrewHtml', DAY, J()[0].dayLogs[DAY]);
  assert.match(closed, /Credited 1\.8 hrs/);
  assert.match(closed, /7:30 AM – 3:15 PM/);
  assert.match(closed, /7\.8 hrs/);
  assert.doesNotMatch(closed, CREW_CARD_LECTURE);
  assert.equal(closed.includes('>Save<'), false);
  holder.remove();
});

test('a crew sign-in does not see the day hour total, and owner and office do', () => {
  useFakeCrew();
  putJobs([{
    id: 'north', customer: 'North Shop', status: 'in_progress', startDate: DAY, endDate: DAY,
    value: '18500', displayVal: '$18,500',
    dayLogs: { [DAY]: {
      startTime: '7:30 AM', endTime: '3:15 PM', overtimeWage: true,
      crewPresent: [
        { crewIdx: 0, name: 'Avery Cole', burdenedRate: '41.50', directRate: '30.25' },
        { crewIdx: 1, name: 'Blake Diaz', burdenedRate: '41.50', directRate: '30.25' },
      ],
    } },
  }]);
  ev(`_jcId='north'`);

  function openLog() {
    call('openJobCard', 'north');
    call('jcTab', 'log');
    return w.document.getElementById('jc-day-logs').innerHTML
      + w.document.getElementById('jc-meta').textContent;
  }

  w.localStorage.removeItem('fpRole');
  w.localStorage.removeItem('fpOfficeUser');
  showEntry('jobs');
  let html = openLog();
  assert.match(html, /Time on site:/);
  assert.match(html, /id="jch-20260623"/);
  assert.match(html, />7\.8 hrs</);
  assert.equal((html.match(/7:30 AM – 3:15 PM/g) || []).length, 2);
  assert.equal(html.includes('15.6'), false);

  w.localStorage.setItem('fpOfficeUser', 'Ops Reviewer');
  showEntry('crewview');
  html = openLog();
  assert.match(html, /Time on site:/);
  assert.match(html, />7\.8 hrs</);
  assert.equal(html.includes('Pay for this day'), false);
  assert.equal(html.includes('18500'), false);

  w.localStorage.setItem('fpRole', 'crew');
  w.localStorage.removeItem('fpOfficeUser');
  w.document.body.classList.add('crew-mode');
  showEntry('crewview');
  html = openLog();
  assert.equal(html.includes('Time on site'), false);
  assert.equal(html.includes('id="jch-20260623"'), false);
  assert.equal(html.includes('Pay for this day'), false);
  assert.equal(html.includes('1.5×'), false);
  assert.equal(html.includes('18500'), false);
  assert.equal(html.includes('$18,500'), false);
  assert.equal(html.includes('41.50'), false);
  assert.equal(html.includes('30.25'), false);
  assert.equal(html.includes('15.6'), false);
  assert.equal(html.includes('Hours'), false);
  assert.equal(html.includes('7.8 hrs'), false);
  assert.equal(html.includes('Credited'), false);
  assert.equal((html.match(/7:30 AM – 3:15 PM/g) || []).length, 2);
  assert.equal((html.match(/Different time\?/g) || []).length, 2);
  assert.equal(w.document.getElementById('jc-tab-costing').style.display, 'none');
  assert.equal(w.document.getElementById('jc-value-group').style.display, 'none');
  assert.equal(w.document.getElementById('jc-value').value, '');

  w.localStorage.removeItem('fpRole');
  w.document.body.classList.remove('crew-mode');
  showEntry('dashboard');
});
