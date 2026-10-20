// Pure PIN helpers shared by the Edge Functions and the local tests.
// No Deno or database imports.

export const PIN_WINDOW_MS = 15 * 60 * 1000;
// Per-person lockout lives in the database (public.fp_pin_fail): 5 misses in a row
// locks that one account. These network limits are only a backstop against noise.
// There is deliberately no global cap any more: one stranger could use it to lock the
// whole crew out at 6 AM.
export const PIN_MAX_FAILS_PER_IP = 20;
// Failed sign-ins across everyone in PIN_WINDOW_MS that raise a "spike" alert to the owner.
export const PIN_SPIKE_ALERT = 20;

const KIND_RANK = { owner: 0, office: 1, crew: 2 };

// Owner and office use 6-digit codes, crew 4. An owner/office account still on its
// old 4-digit code (must_change_pin) is checked at its stored pin_len.
export function pinLengthFor(kind) {
  return kind === 'crew' ? 4 : 6;
}

export function normalizePin(pin, len) {
  const s = String(pin ?? '').trim();
  if (len) return new RegExp('^\\d{' + len + '}$').test(s) ? s : '';
  return /^(\d{4}|\d{6})$/.test(s) ? s : '';
}

export function sortAccounts(rows) {
  return [...(rows || [])].sort((a, b) => {
    const byKind = (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9);
    if (byKind) return byKind;
    if (a.kind === 'crew') return (Number(a.crew_idx) || 0) - (Number(b.crew_idx) || 0);
    return String(a.label || '').localeCompare(String(b.label || ''));
  });
}

// The names shown on the sign-in screen. Never includes hashes or lock details.
export function rosterFrom(rows, inactive) {
  return sortAccounts(rows)
    .filter((r) => !(r.kind === 'crew' && isInactiveCrew(r.crew_idx, inactive)))
    .map((r) => ({ id: r.id, kind: r.kind, label: r.label || '', pin_len: r.pin_len || 4 }));
}

export function isLocked(row, nowMs) {
  if (!row || !row.locked_until) return false;
  const until = row.locked_until === 'infinity' ? Infinity : new Date(row.locked_until).getTime();
  return until > nowMs;
}

export function isInactiveCrew(crewIdx, inactive) {
  if (inactive == null || typeof inactive !== 'object' || Array.isArray(inactive)) return false;
  return Object.prototype.hasOwnProperty.call(inactive, String(crewIdx));
}

export function rateLimitExceeded(attempts, nowMs, ip) {
  const recentFails = (attempts || []).filter((a) => !a.ok && nowMs - a.at < PIN_WINDOW_MS);
  return recentFails.filter((a) => a.ip === ip).length >= PIN_MAX_FAILS_PER_IP;
}

export function spikeCount(attempts, nowMs) {
  return (attempts || []).filter((a) => !a.ok && nowMs - a.at < PIN_WINDOW_MS).length;
}

export function clientIpFromHeaders(headers) {
  const fwd = headers.get('x-forwarded-for') || '';
  const ip = fwd.split(',')[0].trim()
    || headers.get('cf-connecting-ip')
    || headers.get('x-real-ip')
    || 'unknown';
  return ip.slice(0, 80);
}
