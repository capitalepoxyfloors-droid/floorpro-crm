/**
 * "Lead may already be a job" should flag only when the lead is very likely
 * the same work as a job on the board. No live network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(url, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const u = String(url);
  if (!u.includes('/rest/v1/') && !u.includes('/storage/') && !u.includes('/functions/')) {
    return Promise.resolve(new Response('', { status: 200 }));
  }
  if (method === 'GET') return Promise.resolve(jsonResponse([]));
  if (method === 'POST') return Promise.resolve(jsonResponse([{ id: 1 }]));
  return Promise.resolve(new Response(null, { status: 204 }));
}

let w;

function lex(name) {
  return w.eval(name);
}
function setLex(name, value) {
  w.__fpTmp = value;
  w.eval(name + ' = window.__fpTmp');
}
function call(name, ...args) {
  w.__fpArgs = args;
  return w.eval(name + '.apply(undefined, window.__fpArgs)');
}

function runCheck(leads, jobs, acks) {
  setLex('LEADS', leads);
  setLex('_lastJobRows', jobs);
  setLex('LEAD_DUP_ACKS', acks || {});
  setLex('_leadDupMatches', []);
  call('closeModal', 'leaddup');
  call('crossCheckLeadsVsJobs');
  return {
    matches: JSON.parse(JSON.stringify(lex('_leadDupMatches'))),
    open: w.document.getElementById('modal-leaddup').classList.contains('open'),
  };
}

test.before(async () => {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  virtualConsole.on('error', () => {});
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1/',
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
  await new Promise(r => setTimeout(r, 50));
});

test.after(() => {
  if (w) w.close();
});

test('repeat customer with a different amount is not flagged', () => {
  const jobs = [
    { id: 10, customer: 'Thomas Construction', value: '2667.56', status: 'scheduled', notes: '' },
  ];
  const leads = [
    { db_id: 1, name: 'Thomas Construction', value: '5250', stage: 'quoted', notes: 'Wave #680 | 2026-10-01' },
    { db_id: 2, name: 'Thomas Construction', value: '6073.80', stage: 'quoted', notes: 'Wave #683 | 2026-10-02' },
  ];
  const result = runCheck(leads, jobs);
  assert.deepEqual(result.matches, []);
  assert.equal(result.open, false);
});

test('same name and a matching amount is flagged', () => {
  const jobs = [
    { id: 10, customer: 'Thomas Construction', value: '2667.56', status: 'scheduled', notes: '' },
    { id: 11, customer: 'Thomas Construction', value: '5250', status: 'approved', notes: '' },
  ];
  const exact = runCheck([
    { db_id: 3, name: 'Thomas Construction', value: '5250', stage: 'quoted', notes: '' },
  ], jobs);
  assert.equal(exact.matches.length, 1);
  assert.equal(exact.matches[0].name, 'Thomas Construction');
  assert.equal(exact.matches[0].jobLabel, 'Approved');
  assert.equal(exact.matches[0].jobVal, '$5,250');
  assert.equal(exact.open, true);

  const withinDollars = runCheck([
    { db_id: 4, name: 'Thomas Construction', value: '420', stage: 'quoted', notes: '' },
  ], [
    { id: 12, customer: 'Thomas Construction', value: '400', status: 'scheduled', notes: '' },
  ]);
  assert.equal(withinDollars.matches.length, 1, 'within $25');

  const withinPercent = runCheck([
    { db_id: 5, name: 'Thomas Construction', value: '4900', stage: 'followup', notes: '' },
  ], [
    { id: 13, customer: 'Thomas Construction', value: '5000', status: 'inprogress', notes: '' },
  ]);
  assert.equal(withinPercent.matches.length, 1, 'within 2%');

  const justOver = runCheck([
    { db_id: 6, name: 'Thomas Construction', value: '4899', stage: 'quoted', notes: '' },
  ], [
    { id: 14, customer: 'Thomas Construction', value: '5000', status: 'scheduled', notes: '' },
  ]);
  assert.deepEqual(justOver.matches, [], 'more than 2% and more than $25');
});

test('the same Wave estimate number is flagged even when the amounts differ', () => {
  const result = runCheck([
    { db_id: 7, name: 'North Shop', value: '1000', stage: 'quoted', notes: 'Wave #700 | 2026-10-01' },
  ], [
    { id: 20, customer: 'North Shop Remodel', value: '4000', status: 'approved', notes: 'Wave #700 | 2026-10-03' },
    { id: 21, customer: 'North Shop', value: '1000', status: 'scheduled', notes: 'Wave #701 | 2026-10-04' },
  ]);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].leadKey, '7');
  assert.equal(result.matches[0].jobLabel, 'Approved');
  assert.equal(result.matches[0].jobVal, '$4,000');
  assert.equal(result.open, true);

  const differentNumbers = runCheck([
    { db_id: 8, name: 'Ace Flooring', value: '2000', stage: 'quoted', notes: 'Wave #801 | 2026-10-01' },
  ], [
    { id: 22, customer: 'Ace Flooring', value: '2000', status: 'scheduled', notes: 'Wave #802 | 2026-10-02' },
  ]);
  assert.deepEqual(differentNumbers.matches, [], 'different Wave numbers are different estimates');
});

test('an acknowledged lead stays quiet', () => {
  const leads = [
    { db_id: 3, name: 'Thomas Construction', value: '5250', stage: 'quoted', notes: 'Wave #680 | 2026-10-01' },
  ];
  const jobs = [
    { id: 11, customer: 'Thomas Construction', value: '5250', status: 'approved', notes: 'Wave #680 | 2026-10-01' },
  ];
  const flagged = runCheck(leads, jobs);
  assert.equal(flagged.matches.length, 1);
  const quiet = runCheck(leads, jobs, { '3': true });
  assert.deepEqual(quiet.matches, []);
  assert.equal(quiet.open, false);
});
