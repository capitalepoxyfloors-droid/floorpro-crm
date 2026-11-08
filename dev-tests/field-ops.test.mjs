/**
 * Review-only field ops. The migration is not applied. Fetch is mocked.
 * These tests do not prove Postgres accepted a write.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261108013000_field_ops_review.sql'), 'utf8');
const undo = fs.readFileSync(path.join(root, 'supabase/rollback/20261108013000_field_ops_review.sql'), 'utf8');

test('the review migration refuses the wrong project and does not copy or delete documents', () => {
  assert.match(sql, /nndjnywtkgxwvxajwztg/);
  assert.match(sql, /wrong project refusal/);
  assert.match(sql, /live project refusal/);
  assert.match(sql, /cngbsmmdfxmerlqnkate/);
  assert.match(sql, /job_document_revisions_one_current/);
  assert.match(sql, /WHERE is_current/);
  assert.match(sql, /stale_revision/);
  assert.match(sql, /stale_order/);
  assert.match(sql, /idempotency_conflict/);
  assert.match(sql, /fp_stop_member/);
  assert.match(sql, /caller-controlled/);
  assert.equal(sql.includes('vehicle-docs authenticated all') && sql.includes('CREATE POLICY "vehicle-docs authenticated all"'), false);
  assert.match(sql, /fp_issues_open_unassigned/);
  assert.match(sql, /private\.fp_is_staff\(\)/);
  assert.match(sql, /private\.fp_role\(\)/);
  assert.equal(sql.includes('user_metadata'), false);
  assert.equal(sql.includes('service_role'), false);
  assert.equal(/INSERT INTO public\.settings/i.test(sql), false);
  assert.equal(/DELETE FROM public\.settings/i.test(sql), false);
  assert.equal(/job_records/i.test(sql) && /UPDATE public\.settings/i.test(sql), false);
  assert.equal(/GRANT\s+DELETE/i.test(sql), false);
  const crewWrite = sql.split('CREATE POLICY fp_settings_insert')[1].split('CREATE POLICY fp_settings_update')[0];
  assert.equal(crewWrite.includes("'job_docs'"), false);
  assert.equal(undo.includes('CREATE POLICY "vehicle-docs authenticated all"'), false);
  const undoCrew = undo.split('CREATE POLICY fp_settings_insert')[1].split('CREATE POLICY fp_settings_update')[0];
  assert.equal(undoCrew.includes("'job_docs'"), false);
  assert.equal(/DELETE FROM public\.settings/i.test(undo), false);
  assert.equal(/DELETE FROM public\.job_records/i.test(undo), false);
});

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const rpcCalls = [];
const storageCalls = [];
let uploadOk = false;
let issueResult = { ok: false };

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function mockFetch(url, opts = {}) {
  const u = String(url);
  const method = String(opts.method || 'GET').toUpperCase();
  let body = null;
  if (opts.body && typeof opts.body === 'string') {
    try { body = JSON.parse(opts.body); } catch { body = opts.body; }
  }
  if (u.includes('/storage/v1/object/')) {
    storageCalls.push(u);
    return Promise.resolve(new Response(uploadOk ? '{}' : 'no', { status: uploadOk ? 200 : 500 }));
  }
  if (u.includes('/rest/v1/rpc/')) {
    rpcCalls.push({ url: u, body });
    if (u.includes('fp_field_ops_ready')) return Promise.resolve(jsonResponse({ documents: false }));
    if (u.includes('fp_documents_for_job')) return Promise.resolve(jsonResponse([
      { document_id: 'doc-a', title: 'QA Synthetic plan', revision_id: 'rev-a', byte_size: 77 },
      { document_id: 'doc-b', title: 'QA Synthetic plan', revision_id: 'rev-b', byte_size: 84 },
    ]));
    if (u.includes('fp_document_history')) return Promise.resolve(jsonResponse([
      { revision_id: 'rev-old', byte_size: 77, is_current: false },
      { revision_id: 'rev-a', byte_size: 90, is_current: true },
    ]));
    if (u.includes('fp_document_promote')) {
      if (body && body.p_expected) return Promise.resolve(jsonResponse(body.p_revision || 'rev-new'));
      return Promise.resolve(jsonResponse({ message: 'stale_revision' }, 409));
    }
    if (u.includes('fp_document_create')) return Promise.resolve(jsonResponse('doc-1'));
    if (u.includes('fp_document_stage_revision')) return Promise.resolve(jsonResponse('rev-1'));
    if (u.includes('fp_issue_create')) {
      if (!issueResult.ok) return Promise.resolve(jsonResponse({ message: 'not allowed' }, 403));
      return Promise.resolve(jsonResponse(issueResult.id));
    }
    if (u.includes('fp_stop_order_set')) return Promise.resolve(jsonResponse({ message: 'stale_order' }, 409));
    return Promise.resolve(jsonResponse({ message: 'missing' }, 404));
  }
  if (u.includes('/auth/v1/token')) return Promise.resolve(jsonResponse({ access_token: 'access-office', refresh_token: 'refresh-office', expires_in: 3600 }));
  if (u.includes('/functions/v1/pin-admin')) return Promise.resolve(jsonResponse({ kind: 'office', display_name: 'Ops Reviewer', office_id: 'ops' }));
  if (method === 'GET') return Promise.resolve(jsonResponse([]));
  return Promise.resolve(jsonResponse([{ id: 1 }]));
}

let w;
function ev(src) { return w.eval(src); }

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
      window.confirm = () => false;
      const origInterval = window.setInterval.bind(window);
      window.setInterval = (fn, ms, ...args) => (ms >= 500 ? 0 : origInterval(fn, ms, ...args));
      window.CSS = window.CSS || { escape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); } };
    },
  });
  w = dom.window;
  await new Promise(r => setTimeout(r, 40));
});

test('a missing schema hides the issue button and does not offer no-work or a saved plan', async () => {
  ev(`JOB_RECORDS.splice(0,JOB_RECORDS.length,{id:'north',customer:'North Warehouse',scope:'Prime the floor.',jobType:'epoxy',startDate:'2026-11-02',endDate:'2026-11-02',dayLogs:{'2026-11-02':{notes:'',task:'',startTime:'8:00 AM',endTime:'4:00 PM',crewPresent:[{name:'Avery Cole',crewIdx:0}]}}});`);
  ev("_jcId='north'; _fpOps={state:'unknown'};");
  w.localStorage.setItem('fpRole', 'crew');
  w.document.body.classList.add('crew-mode');
  ev("openJobCard('north'); jcTab('log');");
  await new Promise(r => setTimeout(r, 40));
  const log = w.document.getElementById('jc-day-logs').textContent;
  assert.equal(log.includes('No Work Completed'), false);
  assert.equal(log.includes('Record issue'), false);
  ev("jcTab('info');");
  await new Promise(r => setTimeout(r, 20));
  assert.match(w.document.getElementById('fp-current-plans').textContent, /not on this test yet/);
  assert.equal(w.document.getElementById('fp-doc-title'), null);
  assert.equal(w.document.getElementById('jc-doc-upload-btn').style.display, 'none');
});

test('a failed upload does not promote, and a denied issue keeps the note', async () => {
  rpcCalls.length = 0;
  storageCalls.length = 0;
  uploadOk = false;
  ev("_fpOps={state:'ready',data:{documents:true,issues:true,stop_order:true}}; localStorage.setItem('fpRole','office'); document.body.classList.remove('crew-mode');");
  ev("_fpPaintCurrentPlans();");
  const title = w.document.getElementById('fp-doc-title');
  title.value = 'Main floor plan';
  const input = w.document.getElementById('fp-doc-file');
  const file = new w.File(['abc'], 'plan.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await ev('_fpSaveCurrentPlan()');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(storageCalls.length > 0, true);
  assert.equal(rpcCalls.some(c => c.url.includes('fp_document_promote')), false);
  assert.match(w.document.getElementById('fp-doc-status').textContent, /Not saved/);
  ev("_fpIsCrew=function(){return true;}; _fpIssueDraft={note:'Gate was locked.', key:'same-key', status:''}; _fpPaintIssueForm();");
  issueResult = { ok: false };
  await ev('_fpRecordIssue()');
  assert.equal(ev('_fpIssueDraft.note'), 'Gate was locked.');
  assert.match(w.document.getElementById('fp-issue-status').textContent, /Not recorded/);
  issueResult = { ok: true, id: 'issue-1' };
  await ev('_fpRecordIssue()');
  const sent = rpcCalls.filter(c => c.url.includes('fp_issue_create'));
  assert.equal(sent.length >= 2, true);
  assert.equal(sent[0].body.p_key, sent[1].body.p_key);
  assert.equal(ev('_fpIssueDraft.note'), '');
  assert.match(w.document.getElementById('fp-issue-status').textContent, /Issue recorded/);
  assert.equal(w.document.body.textContent.includes('Office notified'), false);
});

test('office can still call the old document save, and crew cannot write it', async () => {
  const writes = [];
  const orig = w.fetch;
  w.fetch = (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/settings') && String(opts.method).toUpperCase() === 'POST') writes.push(opts.body);
    return orig(url, opts);
  };
  w.localStorage.setItem('fpRole', 'crew');
  await ev("jcUploadJobDocFiles([new File(['x'], 'a.pdf')])");
  assert.equal(writes.length, 0);
  w.localStorage.setItem('fpRole', 'office');
  await ev('jcUploadJobDocFiles([])');
  assert.equal(writes.length, 0);
  assert.equal(html.includes('async function saveJobDocs'), true);
  w.fetch = orig;
});

test('a new version updates the chosen plan and does not create another plan', async () => {
  rpcCalls.length = 0;
  uploadOk = true;
  ev("_fpIsCrew=function(){return localStorage.getItem('fpRole')==='crew'||document.body.classList.contains('crew-mode');}; _fpOps={state:'ready'}; _jcId='qa-a'; localStorage.setItem('fpRole','office'); document.body.classList.remove('crew-mode');");
  ev('_fpPaintCurrentPlans()');
  await new Promise(r => setTimeout(r, 40));
  const office = w.document.getElementById('fp-plan-docs').textContent;
  assert.match(office, /77 bytes/);
  assert.match(office, /84 bytes/);
  assert.match(office, /Save new version/);
  const file = new w.File(['version-three'], 'v3.txt', { type: 'text/plain' });
  w._qaFile = file;
  await ev("_fpSavePlanVersion({document_id:'doc-a', revision_id:'rev-a', title:'QA Synthetic plan'}, _qaFile)");
  await new Promise(r => setTimeout(r, 30));
  assert.equal(rpcCalls.some(c => c.url.includes('fp_document_create')), false);
  const promote = rpcCalls.filter(c => c.url.includes('fp_document_promote'));
  assert.equal(promote.length, 1);
  assert.equal(promote[0].body.p_document, 'doc-a');
  assert.equal(promote[0].body.p_expected, 'rev-a');
  assert.match(w.document.getElementById('fp-doc-status').textContent, /^Saved\.$/);
  const older = [...w.document.querySelectorAll('button')].find(b => b.textContent === 'Older versions');
  older.click();
  await new Promise(r => setTimeout(r, 20));
  const history = w.document.querySelector('.fp-plan-history').textContent;
  assert.match(history, /Current version/);
  assert.match(history, /Older version/);
  ev("localStorage.setItem('fpRole','crew'); document.body.classList.add('crew-mode'); _fpPaintCurrentPlans();");
  await new Promise(r => setTimeout(r, 40));
  const crew = w.document.getElementById('fp-plan-docs').textContent;
  assert.equal(crew.includes('Save new version'), false);
  assert.equal(crew.includes('Older versions'), false);
  assert.match(crew, /Open QA Synthetic plan/);
});

test('an extra stored stop keeps its own schedule link', () => {
  const removals = ev("jcStaleSlotMapRemovals({'5_0_6':'job-b','5_0_6_job-a':'job-a','bad key':'job-a'}, [{id:'job-a'},{id:'job-b'}])");
  const keys = removals.map(r => r.key);
  assert.equal(keys.includes('5_0_6_job-a'), false);
  assert.equal(keys.includes('bad key'), true);
});

test('a stale stop-order save leaves the previous order', async () => {
  rpcCalls.length = 0;
  ev("_slotMapLoadOk=true; _fpStopAck['0|2026-11-02']={revision:2, ids:['north','east']};");
  await ev("_fpPersistMove(0,'2026-11-02','north',1)");
  assert.equal(JSON.stringify(ev("_fpStopAck['0|2026-11-02'].ids")), JSON.stringify(['north', 'east']));
  assert.equal(ev("_fpStopAck['0|2026-11-02'].revision"), 2);
  const sent = rpcCalls.filter(c => c.url.includes('fp_stop_order_set'));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.p_ids, ['east', 'north']);
  assert.equal(sent[0].body.p_expected, 2);
});
