/**
 * Owner notice when Wave links an accepted estimate to a job already on the board.
 * Crew must not see that notice or the accepted amount. No live network.
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

const notice = {
  id: '9675',
  kind: 'choose',
  estimate: '9675',
  at: '2026-11-02T14:00:00Z',
  incomingCustomer: 'Matt Haeffner',
  newJobId: 'job-new',
  acceptedAmount: '$99,999.99',
  candidates: [
    { jobId: 'job-pool', customer: 'Haeffner - Pool House Garage', status: 'inprogress', waveNum: '674', notes: 'Wave #674 | 2026-10-07', kind: 'job' },
  ],
};

let store;
let w;

function mockFetch(url, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const u = String(url);
  if (u.includes('/rest/v1/settings') && method === 'GET' && u.includes('wave_link_notices')) {
    return Promise.resolve(jsonResponse(store.wave_link_notices == null ? [] : [{ key: 'wave_link_notices', value: store.wave_link_notices }]));
  }
  if (u.includes('/rest/v1/settings') && method === 'POST') {
    const body = JSON.parse(opts.body);
    store[body.key] = body.value;
    return Promise.resolve(jsonResponse([body]));
  }
  if (u.includes('/rest/v1/jobs') && method === 'GET') return Promise.resolve(jsonResponse([]));
  if (u.includes('/rest/v1/audit_log')) return Promise.resolve(jsonResponse([{ id: 1 }]));
  if (method === 'GET') return Promise.resolve(jsonResponse([]));
  if (method === 'POST') return Promise.resolve(jsonResponse([{ id: 1 }]));
  return Promise.resolve(new Response(null, { status: 204 }));
}

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

test.before(async () => {
  store = { wave_link_notices: JSON.stringify({ allow: [], notices: [notice] }) };
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
  await new Promise(r => setTimeout(r, 80));
});

test.after(() => {
  if (w) w.close();
});

test('note rewrite keeps the old estimate and the approved date', () => {
  const once = call('_waveRewriteNote', 'Wave #9685 | 2026-10-01', '9693');
  assert.equal(once, 'Wave #9693 | superseded #9685 | 2026-10-01');
  assert.equal(call('_waveRewriteNote', once, '9693'), once);
  assert.equal(call('_parseApprovedDate', once), '2026-10-01');
  assert.equal(call('_parseApprovedDate', 'Wave #674 | 2026-10-07'), '2026-10-07');
});

test('owner can choose replacement or a new card; crew sees neither', () => {
  w.localStorage.removeItem('fpRole');
  w.localStorage.removeItem('fpCrewPreview');
  setLex('WAVE_LINK_NOTICES', [notice]);
  call('_renderWaveLinkBanner');
  const banner = w.document.getElementById('wave-link-banner');
  assert.equal(banner.style.display, 'block');
  assert.match(banner.textContent, /added as a new card/);
  assert.match(banner.textContent, /Replaces #674 on Haeffner - Pool House Garage/);
  assert.match(banner.textContent, /New job card/);
  assert.match(banner.textContent, /\$99,999\.99/);
  assert.match(banner.textContent, /No existing job was changed/);

  call('addJobCard', 'Matt Haeffner', 'Epoxy', '99999.99', '$99,999.99', '', 'approved', 'job-new', { notes: 'Wave #9675 | 2026-11-02' });
  const card = w.document.querySelector('#jobs-col-approved .lead-card');
  assert.ok(card);
  assert.match(card.textContent, /New estimate — replacement\?/);
  call('addJobCard', 'Haeffner - Pool House Garage', 'Epoxy', '1500.00', '$1,500', '', 'inprogress', 'job-pool', { notes: 'Wave #674 | 2026-10-07' });
  const existing = w.document.querySelector('#jobs-col-inprogress .lead-card');
  assert.ok(existing);
  assert.doesNotMatch(existing.textContent, /replacement/);

  w.localStorage.setItem('fpRole', 'crew');
  call('_renderWaveLinkBanner');
  assert.equal(banner.style.display, 'none');
  assert.equal(banner.textContent, '');
  assert.equal(banner.innerHTML.includes('99,999'), false);
});

test('New job card dismisses the question and leaves the card', async () => {
  w.localStorage.removeItem('fpRole');
  setLex('WAVE_LINK_NOTICES', [notice]);
  call('_renderWaveLinkBanner');
  await call('waveLinkKeepNew', '9675');
  const saved = JSON.parse(store.wave_link_notices);
  assert.deepEqual(saved.notices, []);
  const banner = w.document.getElementById('wave-link-banner');
  assert.equal(banner.textContent.includes('99,999'), false);
});
