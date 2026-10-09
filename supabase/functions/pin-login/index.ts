// Verifies a keypad PIN and returns a Supabase Auth session.
// Deploy with JWT verification OFF. This function is the login step, so the
// caller does not have a user token yet. It rate-limits and never returns hashes.
//
//   supabase functions deploy pin-login --no-verify-jwt
//
// Tradeoff, short version: a 4-digit PIN is too short to be a Supabase password
// (Auth rejects passwords under 6 characters) and too easy to guess if the
// browser can try it directly. Checking it here lets us hash the PIN, hide the
// hash from the app, slow guessing, and still hand the app a normal Auth session.

import { createClient } from 'npm:@supabase/supabase-js@2';
import bcrypt from 'npm:bcryptjs@2.4.3';
import {
  PIN_WINDOW_MS,
  clientIpFromHeaders,
  isInactiveCrew,
  matchPin,
  normalizePin,
  rateLimitExceeded,
} from '../_shared/pins.mjs';
import { corsHeaders, envKeys, json } from '../_shared/http.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const { url, service, anon } = envKeys();
  if (!url || !service || !anon) return json({ error: 'Sign-in is not configured on the server.' }, 503);

  let body: { pin?: string } = {};
  try {
    const text = await req.text();
    if (text.length > 200) return json({ error: 'Bad request' }, 400);
    body = text ? JSON.parse(text) : {};
  } catch {
    return json({ error: 'Bad request' }, 400);
  }
  const pin = normalizePin(body.pin);
  if (!pin) return json({ error: 'That PIN was not recognized.' }, 401);

  const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const ip = clientIpFromHeaders(req.headers);
  const since = new Date(Date.now() - PIN_WINDOW_MS).toISOString();
  const { data: recent, error: recentErr } = await db
    .from('pin_attempts')
    .select('ip, ok, created_at')
    .gte('created_at', since)
    .limit(500);
  if (recentErr) {
    console.error('pin attempt read failed', recentErr.message);
    return json({ error: 'Sign-in is unavailable. Try again in a minute.' }, 503);
  }
  const attempts = (recent || []).map((row) => ({
    ip: row.ip,
    ok: row.ok,
    at: new Date(row.created_at).getTime(),
  }));
  if (rateLimitExceeded(attempts, Date.now(), ip)) {
    return json({ error: 'Too many tries. Wait 15 minutes and try again.' }, 429);
  }

  const { data: accounts, error: acctErr } = await db
    .from('pin_accounts')
    .select('id, kind, crew_idx, office_id, label, pin_hash, auth_user_id, email');
  if (acctErr) {
    console.error('pin account read failed', acctErr.message);
    return json({ error: 'Sign-in is unavailable. Try again in a minute.' }, 503);
  }

  const match = matchPin(pin, accounts || [], (candidate, hash) => bcrypt.compareSync(candidate, hash));
  let inactive = false;
  if (match && match.kind === 'crew') {
    const { data: inactiveRow } = await db.from('settings').select('value').eq('key', 'crew_inactive').maybeSingle();
    let parsed: unknown = null;
    try { parsed = inactiveRow?.value ? JSON.parse(inactiveRow.value) : null; } catch { parsed = null; }
    inactive = isInactiveCrew(match.crew_idx, parsed);
  }

  if (!match || inactive) {
    await db.from('pin_attempts').insert({ ip, ok: false });
    return json({ error: 'That PIN was not recognized.' }, 401);
  }

  try {
    const session = await ensureSession(db, url, service, anon, match);
    await db.from('pin_attempts').delete().lt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    return json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      token_type: session.token_type || 'bearer',
      account: publicAccount(match),
    });
  } catch (err) {
    console.error('session issue failed', err instanceof Error ? err.message : 'unknown');
    return json({ error: 'Sign-in is unavailable. Try again in a minute.' }, 503);
  }
});

function publicAccount(row: {
  kind: string;
  crew_idx: number | null;
  office_id: string | null;
  label: string;
}) {
  return {
    kind: row.kind,
    crew_idx: row.kind === 'crew' ? row.crew_idx : null,
    office_id: row.kind === 'office' ? row.office_id : null,
    display_name: row.label || '',
  };
}

async function ensureSession(
  db: ReturnType<typeof createClient>,
  url: string,
  service: string,
  anon: string,
  row: {
    id: string;
    kind: string;
    crew_idx: number | null;
    label: string;
    auth_user_id: string | null;
    email: string | null;
  },
) {
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = row.email || `p${row.id.replace(/-/g, '')}@pin.floorpro.invalid`;
  const appMetadata = {
    fp_role: row.kind,
    crew_idx: row.kind === 'crew' ? row.crew_idx : null,
    display_name: row.label || '',
  };

  let userId = row.auth_user_id;
  if (!userId) {
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: appMetadata,
    });
    if (created.error || !created.data.user) {
      throw new Error(created.error?.message || 'createUser failed');
    }
    userId = created.data.user.id;
    const saved = await db.from('pin_accounts').update({
      auth_user_id: userId,
      email,
      updated_at: new Date().toISOString(),
    }).eq('id', row.id);
    if (saved.error) throw new Error(saved.error.message);
  } else {
    const updated = await admin.auth.admin.updateUserById(userId, { app_metadata: appMetadata });
    if (updated.error) throw new Error(updated.error.message);
  }

  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (link.error || !link.data?.properties?.hashed_token) {
    throw new Error(link.error?.message || 'generateLink failed');
  }
  const tokenHash = link.data.properties.hashed_token;
  const types = [link.data.properties.verification_type, 'email', 'magiclink'].filter(Boolean);
  const anonClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  let last = 'verify failed';
  for (const type of [...new Set(types)]) {
    const verified = await anonClient.auth.verifyOtp({
      type: type as 'email',
      token_hash: tokenHash,
    });
    if (!verified.error && verified.data.session?.access_token) return verified.data.session;
    last = verified.error?.message || last;
  }
  throw new Error(last);
}
