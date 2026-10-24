/**
 * REST proof for phase-2 role-split row security.
 *
 * Point this at the TEST project only. It refuses the live project ref.
 *
 *   SUPABASE_URL=https://<test-ref>.supabase.co \
 *   SUPABASE_ANON_KEY=<test anon key> \
 *   CREW_JWT=<access token> OFFICE_JWT=<access token> OWNER_JWT=<access token> \
 *   node dev-tests/role-rls-rest.mjs
 *
 * The tokens are the access_token values pin-login returns. This script never
 * calls pin-login and never sends a PIN.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const LIVE_REF = 'cngbsmmdfxmerlqnkate';

export function assertNotLive(url) {
  if (String(url || '').includes(LIVE_REF)) {
    throw new Error('Refusing to run against the live CrewBoard project (' + LIVE_REF + ').');
  }
}

async function rest(baseUrl, { anonKey, jwt, sendApiKey, path, method = 'GET', body }) {
  const headers = { Accept: 'application/json' };
  if (sendApiKey && anonKey) headers.apikey = anonKey;
  if (jwt) headers.Authorization = 'Bearer ' + jwt;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl.replace(/\/$/, '') + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, ok: res.ok, text, json };
}

function denied(status) {
  return status === 401 || status === 403;
}

/**
 * expect is optional. When omitted, failed checks throw AssertionError.
 * Returns nothing. Mutates job_records and pto_requests through the crew RPCs.
 */
export async function assertRoleSplitRest({
  baseUrl,
  anonKey = '',
  sendApiKey = false,
  prefix = '/rest/v1',
  crewJwt,
  officeJwt,
  ownerJwt,
  anonJwt = '',
}) {
  assertNotLive(baseUrl);
  const crew = (path, opts) => rest(baseUrl, { anonKey, jwt: crewJwt, sendApiKey, path: prefix + path, ...opts });
  const office = (path, opts) => rest(baseUrl, { anonKey, jwt: officeJwt, sendApiKey, path: prefix + path, ...opts });
  const owner = (path, opts) => rest(baseUrl, { anonKey, jwt: ownerJwt, sendApiKey, path: prefix + path, ...opts });

  for (const [who, call] of [['crew', crew], ['office', office], ['owner', owner]]) {
    const hourly = await call('/crew?select=hourly');
    assert.ok(denied(hourly.status), who + ' select=hourly status ' + hourly.status + ' ' + hourly.text);
    const phone = await call('/crew?select=phone');
    assert.ok(denied(phone.status), who + ' select=phone status ' + phone.status + ' ' + phone.text);
    const price = await call('/materials?select=price');
    assert.ok(denied(price.status), who + ' select=price status ' + price.status + ' ' + price.text);
  }

  const names = await crew('/crew?select=full_name&order=sort_order.asc');
  assert.equal(names.status, 200, names.text);
  assert.ok(Array.isArray(names.json) && names.json.some(r => /Seth/i.test(r.full_name || '')), JSON.stringify(names.json));

  const star = await crew('/crew?select=*');
  if (star.status === 200) {
    assert.ok(Array.isArray(star.json) && star.json.length > 0, star.text);
    for (const row of star.json) {
      assert.equal('hourly' in row, false, 'select=* leaked hourly: ' + star.text);
      assert.equal('phone' in row, false, 'select=* leaked phone: ' + star.text);
      assert.equal('is_owner' in row, false, 'select=* leaked is_owner: ' + star.text);
    }
  } else {
    assert.ok(denied(star.status), 'select=* status ' + star.status + ' ' + star.text);
  }

  const matNames = await crew('/materials?select=name');
  assert.equal(matNames.status, 200, matNames.text);
  assert.ok(Array.isArray(matNames.json) && matNames.json.some(r => r.name), matNames.text);

  const crewPay = await crew('/crew_private?select=hourly,phone');
  assert.equal(crewPay.status, 200, crewPay.text);
  assert.deepEqual(crewPay.json, []);

  const officePay = await office('/crew_private?select=hourly,phone&order=hourly.asc');
  assert.equal(officePay.status, 200, officePay.text);
  assert.ok(Array.isArray(officePay.json) && officePay.json.some(r => String(r.hourly).startsWith('25')), JSON.stringify(officePay.json));
  const ownerPay = await owner('/crew_private?select=hourly');
  assert.equal(ownerPay.status, 200, ownerPay.text);
  assert.ok(Array.isArray(ownerPay.json) && ownerPay.json.length >= 1, ownerPay.text);

  const crewPrice = await crew('/materials_private?select=price');
  assert.equal(crewPrice.status, 200, crewPrice.text);
  assert.deepEqual(crewPrice.json, []);
  const officePrice = await office('/materials_private?select=price');
  assert.equal(officePrice.status, 200, officePrice.text);
  assert.ok(Array.isArray(officePrice.json) && officePrice.json.some(r => Number(r.price) === 12.5), JSON.stringify(officePrice.json));

  for (const path of ['/jobs?select=customer,value', '/leads?select=name,phone,value', '/vehicles?select=*', '/vehicle_maintenance?select=cost', '/audit_log?select=action,details']) {
    const got = await crew(path);
    assert.equal(got.status, 200, path + ' ' + got.text);
    assert.deepEqual(got.json, [], path + ' was readable by crew: ' + got.text);
  }
  const officeJobs = await office('/jobs?select=customer,value');
  assert.equal(officeJobs.status, 200, officeJobs.text);
  assert.ok(Array.isArray(officeJobs.json) && officeJobs.json.some(r => String(r.value) === '18500'), officeJobs.text);

  for (const key of ['job_records', 'pto_requests', 'costing_settings', 'overhead', 'mileage_rates', 'crew_history', 'crew_attachments']) {
    const got = await crew('/settings?select=key,value&key=eq.' + key);
    assert.equal(got.status, 200, key + ' ' + got.text);
    assert.deepEqual(got.json, [], 'crew could read settings.' + key + ': ' + got.text);
  }
  const photos = await crew('/settings?select=key&key=eq.job_photos');
  assert.equal(photos.status, 200, photos.text);
  assert.equal(photos.json.length, 1, photos.text);
  const slots = await crew('/scheduled_slots?select=label');
  assert.equal(slots.status, 200, slots.text);
  assert.ok(Array.isArray(slots.json) && slots.json.length >= 1, slots.text);

  const officeRecords = await office('/settings?select=value&key=eq.job_records');
  assert.equal(officeRecords.status, 200, officeRecords.text);
  assert.match(officeRecords.json[0].value, /18500/);
  assert.match(officeRecords.json[0].value, /41\.50/);

  const redacted = await crew('/rpc/fp_crew_read_job_records', { method: 'POST', body: {} });
  assert.equal(redacted.status, 200, redacted.text);
  assert.equal(redacted.text.includes('18500'), false, redacted.text);
  assert.equal(redacted.text.includes('41.50'), false, redacted.text);
  assert.equal(redacted.text.includes('28.00'), false, redacted.text);
  assert.match(redacted.text, /Acme Garage/);
  assert.match(redacted.text, /314-555-0199/, 'customer phone stays on the job card');

  const officeRpc = await office('/rpc/fp_crew_read_job_records', { method: 'POST', body: {} });
  assert.ok(officeRpc.status >= 400, 'office should not use the crew reader: ' + officeRpc.text);

  const wrote = await crew('/rpc/fp_crew_write_job_records', {
    method: 'POST',
    body: {
      payload: [{
        id: 'j1',
        customer: 'Acme Garage',
        value: '1',
        phone: '314-555-0199',
        dayLogs: {
          '2026-06-02': {
            task: 'Coat',
            overtimeWage: false,
            crewPresent: [{ crewIdx: 0, name: 'Seth West', burdenedRate: '999', directRate: '1' }],
          },
        },
      }],
    },
  });
  assert.equal(wrote.status, 200, wrote.text);
  assert.equal(wrote.text.includes('18500'), false, wrote.text);
  assert.equal(wrote.text.includes('999'), false, wrote.text);
  assert.match(wrote.text, /Coat/);

  const after = await owner('/settings?select=value&key=eq.job_records');
  assert.equal(after.status, 200, after.text);
  const stored = after.json[0].value;
  assert.match(stored, /18500/);
  assert.match(stored, /41\.50/);
  assert.match(stored, /Coat/);
  assert.match(stored, /Hidden Job/);
  assert.equal(stored.includes('999'), false, stored);

  const pto = await crew('/rpc/fp_crew_read_pto_requests', { method: 'POST', body: {} });
  assert.equal(pto.status, 200, pto.text);
  assert.match(pto.text, /Seth dentist/);
  assert.equal(pto.text.includes('Brendon private'), false, pto.text);

  const approve = await crew('/rpc/fp_crew_write_pto_requests', {
    method: 'POST',
    body: {
      payload: [{
        id: 'p1', crewIdx: 1, crewName: 'Brendon Bennett', startDate: '2026-07-01', endDate: '2026-07-01',
        reason: 'Seth dentist', status: 'approved',
      }],
    },
  });
  assert.equal(approve.status, 200, approve.text);
  assert.match(approve.text, /"status": "pending"/);
  assert.equal(approve.text.includes('Brendon private'), false, approve.text);
  const ownerPto = await owner('/settings?select=value&key=eq.pto_requests');
  assert.match(ownerPto.json[0].value, /Brendon private/);
  assert.match(ownerPto.json[0].value, /"status": "pending"/);

  if (anonJwt) {
    const anonJobs = await rest(baseUrl, { anonKey, jwt: anonJwt, sendApiKey, path: prefix + '/jobs?select=value' });
    assert.equal(anonJobs.status, 200, anonJobs.text);
    assert.deepEqual(anonJobs.json, []);
    const anonRpc = await rest(baseUrl, {
      anonKey, jwt: anonJwt, sendApiKey,
      path: prefix + '/rpc/fp_crew_read_job_records', method: 'POST', body: {},
    });
    assert.ok(anonRpc.status >= 400, anonRpc.text);
  }
}

async function main() {
  const baseUrl = process.env.SUPABASE_URL || '';
  assertNotLive(baseUrl);
  if (!baseUrl || !process.env.CREW_JWT || !process.env.OFFICE_JWT || !process.env.OWNER_JWT) {
    console.error('Set SUPABASE_URL, SUPABASE_ANON_KEY, CREW_JWT, OFFICE_JWT, and OWNER_JWT. This script does not sign in.');
    process.exit(1);
  }
  await assertRoleSplitRest({
    baseUrl,
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    sendApiKey: true,
    crewJwt: process.env.CREW_JWT,
    officeJwt: process.env.OFFICE_JWT,
    ownerJwt: process.env.OWNER_JWT,
  });
  console.log('Role-split REST checks passed. Crew cannot read pay, prices, or other people\'s notes.');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
