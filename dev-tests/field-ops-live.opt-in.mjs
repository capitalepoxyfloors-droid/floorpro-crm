/**
 * Opt-in signed-in checks for floorpro-crm-test. Not run unless FIELD_OPS_LIVE=1.
 * Does not contain a PIN, a service key, or a saved token.
 * Pass the signed-in access token only as FIELD_OPS_ACCESS_TOKEN in the environment.
 * This file refuses any URL that is not the test project host.
 */
const TEST_HOST = 'nndjnywtkgxwvxajwztg.supabase.co';
const LIVE_REF = 'cngbsmmdfxmerlqnkate';

if (process.env.FIELD_OPS_LIVE !== '1') {
  console.log('field-ops live harness not run');
  process.exit(0);
}

const supabaseUrl = process.env.FIELD_OPS_SUPABASE_URL || '';
const token = process.env.FIELD_OPS_ACCESS_TOKEN || '';
let host = '';
try { host = new URL(supabaseUrl).host; } catch { host = ''; }
if (host !== TEST_HOST || supabaseUrl.includes(LIVE_REF) || !token || !process.env.FIELD_OPS_ANON_KEY) {
  console.error('refused: test host, anon key, and an access token are required');
  process.exit(2);
}

const cases = [
  ['fp_field_ops_ready', {}],
  ['fp_issues_open_unassigned', {}],
  ['fp_documents_for_job', { p_job: 'not-a-real-job' }],
  ['fp_stop_order_read', { p_idx: 999999, p_date: '2026-11-02' }],
];

let failed = 0;
for (const [name, body] of cases) {
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: process.env.FIELD_OPS_ANON_KEY || '',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const leaked = /hourly|service_role|pin_hash/i.test(text);
  console.log(`${name} ${res.status}${leaked ? ' LEAK' : ''}`);
  if (leaked) failed += 1;
}
process.exit(failed ? 1 : 0);
