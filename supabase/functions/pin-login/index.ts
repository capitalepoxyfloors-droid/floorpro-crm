// Name-first PIN sign-in. Returns a Supabase Auth session.
// Deploy with JWT verification OFF. This function is the login step, so the
// caller does not have a user token yet. It rate-limits and never returns hashes.
//
//   supabase functions deploy pin-login --no-verify-jwt
//
// Requests (POST JSON):
//   { action: "roster" }                       -> { accounts: [{id, kind, label, pin_len}] }
//   { account_id, pin }                        -> session, or { must_change: true, pin_len: 6 }
//   { account_id, pin, new_pin }               -> owner/office first sign-in after cutover:
//                                                 checks the old code, saves the new 6-digit
//                                                 one, then returns a session.
//
// Why name-first (Oct 19 review): with ~10 people sharing one 4-digit space and no
// name, a random guess matched *someone* about 1 time in 1,000, and the old global
// miss cap let one stranger lock the whole crew out. Now each guess is against one
// person, 5 misses locks only that person (public.fp_pin_fail), and the owner gets a
// security alert in the Audit Log + dashboard for every lock and for miss spikes.

import { createClient } from 'npm:@supabase/supabase-js@2';
import bcrypt from 'npm:bcryptjs@2.4.3';
import {
  PIN_SPIKE_ALERT,
  PIN_WINDOW_MS,
  clientIpFromHeaders,
  isInactiveCrew,
  isLocked,
  normalizePin,
  pinLengthFor,
  rateLimitExceeded,
  rosterFrom,
  spikeCount,
} from '../_shared/pins.mjs';
import { corsHeaders, envKeys, json } from '../_shared/http.ts';

type Db = ReturnType<typeof createClient>;
type Row = {
  id: string;
  kind: string;
  crew_idx: number | null;
  office_id: string | null;
  label: string;
  pin_hash: string;
  pin_len: number | null;
  must_change_pin: boolean | null;
  locked_until: string | null;
  auth_user_id: string | null;
  email: string | null;
  session_nonce: number | null;
};

const NOT_RECOGNIZED = 'That PIN was not recognized.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const { url, service, anon } = envKeys();
  if (!url || !service || !anon) return json({ error: 'Sign-in is not configured on the server.' }, 503);

  let body: { action?: string; account_id?: string; pin?: string; new_pin?: string } = {};
  try {
    const text = await req.text();
    if (text.length > 300) return json({ error: 'Bad request' }, 400);
    body = text ? JSON.parse(text) : {};
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

  if (body.action === 'roster') {
    const { data, error } = await db.from('pin_accounts').select('id, kind, crew_idx, label, pin_len');
    if (error) return json({ error: 'Sign-in is unavailable. Try again in a minute.' }, 503);
    return json({ accounts: rosterFrom(data || [], await crewInactiveMap(db)) });
  }

  const ip = clientIpFromHeaders(req.headers);
  const since = new Date(Date.now() - PIN_WINDOW_MS).toISOString();
  const { data: recent, error: recentErr } = await db
    .from('pin_attempts')
    .select('ip, ok, created_at')
    .gte('created_at', since)
    .limit(1000);
  if (recentErr) {
    console.error('pin attempt read failed', recentErr.message);
    return json({ error: 'Sign-in is unavailable. Try again in a minute.' }, 503);
  }
  const attempts = (recent || []).map((row) => ({ ip: row.ip, ok: row.ok, at: new Date(row.created_at).getTime() }));
  if (rateLimitExceeded(attempts, Date.now(), ip)) {
    return json({ error: 'Too many tries from this network. Wait 15 minutes and try again.' }, 429);
  }

  const accountId = String(body.account_id || '');
  let row: Row | null = null;
  if (UUID_RE.test(accountId)) {
    const { data, error } = await db
      .from('pin_accounts')
      .select('id, kind, crew_idx, office_id, label, pin_hash, pin_len, must_change_pin, locked_until, auth_user_id, email, session_nonce')
      .eq('id', accountId)
      .maybeSingle();
    if (error) {
      console.error('pin account read failed', error.message);
      return json({ error: 'Sign-in is unavailable. Try again in a minute.' }, 503);
    }
    row = data as Row | null;
  }
  if (row && row.kind === 'crew' && isInactiveCrew(row.crew_idx, await crewInactiveMap(db))) row = null;
  if (!row) {
    await recordMiss(db, ip, null, attempts);
    return json({ error: NOT_RECOGNIZED }, 401);
  }

  // A locked account is not checked at all, so a lock can't be used to test guesses.
  if (isLocked(row, Date.now())) return json({ error: lockedMessage(row.locked_until), locked: true }, 423);

  const pin = normalizePin(body.pin, row.pin_len || 4);
  const ok = !!pin && safeCompare(pin, row.pin_hash);
  if (!ok) {
    const lock = await recordMiss(db, ip, row, attempts);
    if (lock?.locked) return json({ error: lockedMessage(lock.locked_until), locked: true }, 423);
    return json({ error: NOT_RECOGNIZED }, 401);
  }

  await db.from('pin_attempts').insert({ ip, ok: true, account_id: row.id });
  // Clear only the current streak and lock. lock_count / first_lock_at keep counting
  // lockouts across the 24-hour window, so a good sign-in in between can't reset the
  // "third lockout holds until Unlock" rule. Unlock and a new PIN clear them (pin-admin).
  await db.from('pin_accounts').update({ failed_count: 0, locked_until: null }).eq('id', row.id);

  if (row.must_change_pin) {
    if (body.new_pin == null) return json({ must_change: true, pin_len: pinLengthFor(row.kind) });
    const next = normalizePin(body.new_pin, pinLengthFor(row.kind));
    if (!next) return json({ error: `Your new code must be exactly ${pinLengthFor(row.kind)} digits.`, must_change: true }, 400);
    if (next.startsWith(pin)) return json({ error: 'Pick a new code that does not start with your old one.', must_change: true }, 400);
    const nextNonce = (row.session_nonce || 0) + 1;
    if (row.auth_user_id) await db.rpc('fp_revoke_sessions', { target_user: row.auth_user_id });
    const saved = await db.from('pin_accounts').update({
      pin_hash: bcrypt.hashSync(next, 8),
      pin_len: next.length,
      must_change_pin: false,
      session_nonce: nextNonce,
      updated_at: new Date().toISOString(),
    }).eq('id', row.id);
    if (saved.error) return json({ error: 'Could not save your new code. Try again.', must_change: true }, 503);
    row = { ...row, session_nonce: nextNonce, pin_len: next.length, must_change_pin: false };
    await alert(db, row.label, 'Code changed to 6 digits on first sign-in');
  }

  try {
    const session = await ensureSession(db, url, service, anon, row);
    await db.from('pin_attempts').delete().lt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    return json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      token_type: session.token_type || 'bearer',
      account: publicAccount(row),
    });
  } catch (err) {
    console.error('session issue failed', err instanceof Error ? err.message : 'unknown');
    return json({ error: 'Sign-in is unavailable. Try again in a minute.' }, 503);
  }
});

function safeCompare(pin: string, hash: string) {
  try { return bcrypt.compareSync(pin, hash); } catch { return false; }
}

function lockedMessage(until: string | null | undefined) {
  if (!until || until === 'infinity') return 'This sign-in is locked after too many wrong PINs. Ask Will to unlock it.';
  const mins = Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60000));
  return `Too many wrong PINs. This sign-in is locked for ${mins} more minute${mins === 1 ? '' : 's'}.`;
}

// Logs the miss, counts it against the account, and raises owner alerts.
async function recordMiss(
  db: Db,
  ip: string,
  row: Row | null,
  attempts: { ok: boolean; at: number }[],
): Promise<{ locked?: boolean; held?: boolean; locked_until?: string } | null> {
  await db.from('pin_attempts').insert({ ip, ok: false, account_id: row?.id ?? null });
  let lock: { locked?: boolean; held?: boolean; locked_until?: string } | null = null;
  if (row) {
    const res = await db.rpc('fp_pin_fail', { acct: row.id });
    if (res.error) console.error('fp_pin_fail failed', res.error.message);
    else lock = res.data;
    if (lock?.locked) {
      await alert(db, row.label, lock.held
        ? 'Locked until you unlock it (Security page): 3 lockouts in 24 hours'
        : 'Locked for a while after 5 wrong PINs in a row');
    }
  }
  // +1 for the miss just recorded. Alert once per hour at most.
  if (spikeCount(attempts, Date.now()) + 1 === PIN_SPIKE_ALERT) {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: prior } = await db.from('audit_log').select('id')
      .eq('action', 'security_alert').eq('entity', 'Failed sign-in spike').gte('created_at', hourAgo).limit(1);
    if (!prior || !prior.length) {
      await alert(db, 'Failed sign-in spike', `${PIN_SPIKE_ALERT} wrong PINs across all accounts in 15 minutes`);
    }
  }
  return lock;
}

async function alert(db: Db, entity: string, details: string) {
  const { error } = await db.from('audit_log').insert({
    actor: 'Sign-in security',
    action: 'security_alert',
    entity: entity || 'Sign-in',
    details,
  });
  if (error) console.error('security alert insert failed', error.message);
}

async function crewInactiveMap(db: Db) {
  const { data } = await db.from('settings').select('value').eq('key', 'crew_inactive').maybeSingle();
  try { return data?.value ? JSON.parse(data.value) : null; } catch { return null; }
}

function publicAccount(row: Row) {
  return {
    kind: row.kind,
    crew_idx: row.kind === 'crew' ? row.crew_idx : null,
    office_id: row.kind === 'office' ? row.office_id : null,
    display_name: row.label || '',
  };
}

async function ensureSession(db: Db, url: string, service: string, anon: string, row: Row) {
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = row.email || `p${row.id.replace(/-/g, '')}@pin.floorpro.invalid`;
  const appMetadata = {
    fp_role: row.kind,
    fp_nonce: row.session_nonce ?? 0,
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
    if (created.data.user) {
      userId = created.data.user.id;
    } else {
      // The same pin row already created this login before. Reuse it instead of
      // leaving a second account whose refresh token still works.
      userId = await findAuthUserId(url, service, email);
      if (!userId) throw new Error(created.error?.message || 'createUser failed');
      const linked = await admin.auth.admin.updateUserById(userId, { app_metadata: appMetadata });
      if (linked.error) throw new Error(linked.error.message);
    }
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

async function findAuthUserId(url: string, service: string, email: string) {
  const wanted = email.toLowerCase();
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=200`, {
      headers: { apikey: service, Authorization: `Bearer ${service}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const users = Array.isArray(data) ? data : (data.users || []);
    const hit = users.find((u: { email?: string; id?: string }) => (u.email || '').toLowerCase() === wanted);
    if (hit?.id) return hit.id as string;
    if (users.length < 200) return null;
  }
  return null;
}
