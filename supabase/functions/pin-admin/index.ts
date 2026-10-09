// Owner PIN management, plus a whoami check for every signed-in person.
// Deploy with JWT verification ON (the default).
//
//   supabase functions deploy pin-admin
//
// whoami is how the app learns it is still allowed in. Changing a PIN writes a
// new hash only. The old plaintext rows in settings are left untouched so a
// rollback of the database policies still has the codes from cutover night.

import { createClient } from 'npm:@supabase/supabase-js@2';
import bcrypt from 'npm:bcryptjs@2.4.3';
import { isInactiveCrew, normalizePin } from '../_shared/pins.mjs';
import { corsHeaders, envKeys, json } from '../_shared/http.ts';

type Account = {
  id: string;
  kind: string;
  crew_idx: number | null;
  office_id: string | null;
  label: string;
  auth_user_id: string | null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const { url, service, anon } = envKeys();
  if (!url || !service || !anon) return json({ error: 'Not configured' }, 503);

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Sign in required.' }, 401);

  const anonClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const userRes = await anonClient.auth.getUser(token);
  const user = userRes.data.user;
  if (userRes.error || !user) return json({ error: 'Sign in required.' }, 401);

  const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: self, error: selfErr } = await db
    .from('pin_accounts')
    .select('id, kind, crew_idx, office_id, label, auth_user_id')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (selfErr) return json({ error: 'Could not check this sign-in.' }, 503);
  if (!self) return json({ error: 'This sign-in is no longer valid.' }, 401);
  if (self.kind === 'crew') {
    const blocked = await crewIsInactive(db, self.crew_idx);
    if (blocked) return json({ error: 'This sign-in is no longer valid.' }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.length > 4000) return json({ error: 'Bad request' }, 400);
    body = text ? JSON.parse(text) : {};
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  const action = String(body.action || 'whoami');
  if (action === 'whoami') return json(publicAccount(self));

  const role = user.app_metadata?.fp_role;
  if (role !== 'owner' || self.kind !== 'owner') {
    return json({ error: 'Only the manager code can change PINs.' }, 403);
  }

  try {
    if (action === 'list') return json(await listAccounts(db));
    if (action === 'set_owner_pin') return json(await setOwnerPin(db, body));
    if (action === 'set_crew_pin') return json(await setCrewPin(db, body));
    if (action === 'clear_crew_pin') return json(await clearCrewPin(db, body));
    if (action === 'add_office') return json(await addOffice(db, body));
    if (action === 'set_office_pin') return json(await setOfficePin(db, body));
    if (action === 'remove_office') return json(await removeOffice(db, url, service, body));
    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not save that PIN.';
    const status = message.startsWith('That PIN') || message.startsWith('PIN ') || message.startsWith('There is') || message.startsWith('Enter ')
      ? 409
      : 400;
    return json({ error: message }, status);
  }
});

function publicAccount(row: Account) {
  return {
    kind: row.kind,
    crew_idx: row.kind === 'crew' ? row.crew_idx : null,
    office_id: row.kind === 'office' ? row.office_id : null,
    display_name: row.label || '',
  };
}

async function listAccounts(db: ReturnType<typeof createClient>) {
  const { data, error } = await db
    .from('pin_accounts')
    .select('kind, crew_idx, office_id, label');
  if (error) throw new Error('Could not load the PIN list.');
  const rows = data || [];
  return {
    owner: { has_pin: rows.some((r) => r.kind === 'owner') },
    crew: rows.filter((r) => r.kind === 'crew').map((r) => ({
      crew_idx: r.crew_idx,
      label: r.label,
      has_pin: true,
    })),
    office: rows.filter((r) => r.kind === 'office').map((r) => ({
      office_id: r.office_id,
      name: r.label,
      has_pin: true,
    })),
  };
}

async function setOwnerPin(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const pin = requirePin(body.pin, 4, 6);
  await assertPinFree(db, pin, { kind: 'owner' });
  const { error } = await db.from('pin_accounts').update({
    pin_hash: bcrypt.hashSync(pin, 8),
    updated_at: new Date().toISOString(),
  }).eq('kind', 'owner');
  if (error) throw new Error('Could not save the manager code.');
  return { ok: true };
}

async function setCrewPin(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const crewIdx = requireIndex(body.crew_idx);
  const pin = requirePin(body.pin, 4, 6);
  await assertPinFree(db, pin, { kind: 'crew', crew_idx: crewIdx });
  const label = await crewLabel(db, crewIdx);
  const hash = bcrypt.hashSync(pin, 8);
  const { data: existing } = await db.from('pin_accounts').select('id').eq('kind', 'crew').eq('crew_idx', crewIdx).maybeSingle();
  const write = existing
    ? await db.from('pin_accounts').update({ pin_hash: hash, label, updated_at: new Date().toISOString() }).eq('id', existing.id)
    : await db.from('pin_accounts').insert({ kind: 'crew', crew_idx: crewIdx, label, pin_hash: hash });
  if (write.error) throw new Error('Could not save that crew PIN.');
  return { ok: true };
}

async function clearCrewPin(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const crewIdx = requireIndex(body.crew_idx);
  const { error } = await db.from('pin_accounts').delete().eq('kind', 'crew').eq('crew_idx', crewIdx);
  if (error) throw new Error('Could not clear that PIN.');
  return { ok: true };
}

async function addOffice(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const name = String(body.name || '').trim();
  if (!name) throw new Error('Enter a name.');
  const pin = requirePin(body.pin, 4, 4);
  const { data: existing } = await db.from('pin_accounts').select('id, label').eq('kind', 'office');
  if ((existing || []).some((row) => row.label.toLowerCase() === name.toLowerCase())) {
    throw new Error('There is already office staff named ' + name + '.');
  }
  await assertPinFree(db, pin, { kind: 'office' });
  const officeId = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)).slice(0, 8);
  const { error } = await db.from('pin_accounts').insert({
    kind: 'office',
    office_id: officeId,
    label: name,
    pin_hash: bcrypt.hashSync(pin, 8),
  });
  if (error) throw new Error('Could not add office staff.');
  return { ok: true, office_id: officeId };
}

async function setOfficePin(db: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const officeId = String(body.office_id || '');
  if (!officeId) throw new Error('Missing office staff.');
  const pin = requirePin(body.pin, 4, 4);
  await assertPinFree(db, pin, { kind: 'office', office_id: officeId });
  const { error } = await db.from('pin_accounts').update({
    pin_hash: bcrypt.hashSync(pin, 8),
    updated_at: new Date().toISOString(),
  }).eq('kind', 'office').eq('office_id', officeId);
  if (error) throw new Error('Could not save that PIN.');
  return { ok: true };
}

async function removeOffice(
  db: ReturnType<typeof createClient>,
  url: string,
  service: string,
  body: Record<string, unknown>,
) {
  const officeId = String(body.office_id || '');
  if (!officeId) throw new Error('Missing office staff.');
  const { data: row } = await db.from('pin_accounts').select('auth_user_id').eq('kind', 'office').eq('office_id', officeId).maybeSingle();
  const { error } = await db.from('pin_accounts').delete().eq('kind', 'office').eq('office_id', officeId);
  if (error) throw new Error('Could not remove that person.');
  if (row?.auth_user_id) {
    try {
      await fetch(`${url}/auth/v1/admin/users/${row.auth_user_id}/logout`, {
        method: 'POST',
        headers: {
          apikey: service,
          Authorization: `Bearer ${service}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ scope: 'global' }),
      });
      const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
      await admin.auth.admin.updateUserById(row.auth_user_id, { ban_duration: '876000h' });
    } catch (err) {
      console.error('office revoke failed', err instanceof Error ? err.message : 'unknown');
    }
  }
  return { ok: true };
}

function requirePin(value: unknown, min: number, max: number) {
  const pin = normalizePin(value);
  if (!pin || pin.length < min || pin.length > max) {
    throw new Error(min === max
      ? `PIN must be exactly ${min} digits.`
      : `PIN must be ${min} to ${max} digits, numbers only.`);
  }
  return pin;
}

function requireIndex(value: unknown) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error('Unknown crew member.');
  return n;
}

async function crewLabel(db: ReturnType<typeof createClient>, crewIdx: number) {
  const { data } = await db.from('crew').select('full_name').eq('sort_order', crewIdx).limit(1).maybeSingle();
  return data?.full_name || `Crew ${crewIdx + 1}`;
}

async function assertPinFree(
  db: ReturnType<typeof createClient>,
  pin: string,
  except: { kind: string; crew_idx?: number; office_id?: string },
) {
  const { data, error } = await db.from('pin_accounts').select('id, kind, crew_idx, office_id, label, pin_hash');
  if (error) throw new Error('Could not check that PIN.');
  for (const row of data || []) {
    if (except.kind === row.kind && except.kind === 'owner') continue;
    if (except.kind === 'crew' && row.kind === 'crew' && row.crew_idx === except.crew_idx) continue;
    if (except.kind === 'office' && row.kind === 'office' && row.office_id === except.office_id) continue;
    if (!bcrypt.compareSync(pin, row.pin_hash)) continue;
    if (row.kind === 'owner') throw new Error('That PIN is already used by the manager code.');
    if (row.kind === 'crew') throw new Error('That PIN is already used by ' + (row.label || 'a crew member') + '.');
    throw new Error('That PIN is already used by office staff (' + (row.label || 'someone') + ').');
  }
}

async function crewIsInactive(db: ReturnType<typeof createClient>, crewIdx: number | null) {
  if (crewIdx == null) return false;
  const { data } = await db.from('settings').select('value').eq('key', 'crew_inactive').maybeSingle();
  let parsed: unknown = null;
  try { parsed = data?.value ? JSON.parse(data.value) : null; } catch { parsed = null; }
  return isInactiveCrew(crewIdx, parsed);
}
