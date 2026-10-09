// Pure PIN helpers shared by the Edge Functions and the local tests.
// No Deno or database imports.

export const PIN_WINDOW_MS = 15 * 60 * 1000;
export const PIN_MAX_FAILS_PER_IP = 10;
export const PIN_MAX_FAILS_GLOBAL = 100;

const KIND_RANK = { owner: 0, office: 1, crew: 2 };

export function normalizePin(pin) {
  const s = String(pin ?? '').trim();
  return /^\d{4,6}$/.test(s) ? s : '';
}

export function sortAccounts(rows) {
  return [...(rows || [])].sort((a, b) => {
    const byKind = (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9);
    if (byKind) return byKind;
    return (Number(a.crew_idx) || 0) - (Number(b.crew_idx) || 0);
  });
}

// Always runs verify() for every row so a match does not return early.
// Owner is preferred over office, office over crew, matching the old keypad.
export function matchPin(pin, rows, verify) {
  let found = null;
  for (const row of sortAccounts(rows)) {
    let ok = false;
    try {
      ok = !!verify(pin, row.pin_hash);
    } catch {
      ok = false;
    }
    if (ok && !found) found = row;
  }
  return found;
}

export function isInactiveCrew(crewIdx, inactive) {
  if (inactive == null || typeof inactive !== 'object' || Array.isArray(inactive)) return false;
  return Object.prototype.hasOwnProperty.call(inactive, String(crewIdx));
}

export function rateLimitExceeded(attempts, nowMs, ip) {
  const recentFails = (attempts || []).filter((a) => !a.ok && nowMs - a.at < PIN_WINDOW_MS);
  const byIp = recentFails.filter((a) => a.ip === ip).length;
  return byIp >= PIN_MAX_FAILS_PER_IP || recentFails.length >= PIN_MAX_FAILS_GLOBAL;
}

export function clientIpFromHeaders(headers) {
  const fwd = headers.get('x-forwarded-for') || '';
  const ip = fwd.split(',')[0].trim()
    || headers.get('cf-connecting-ip')
    || headers.get('x-real-ip')
    || 'unknown';
  return ip.slice(0, 80);
}
