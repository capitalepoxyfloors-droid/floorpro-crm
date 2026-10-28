// Refuse a PIN that already matches another person's hash.
// bcrypt salts differ, so this has to compare the new code, not the stored text.
import bcrypt from 'npm:bcryptjs@2.4.3';

export const PIN_IN_USE = 'That PIN is already in use, pick another.';

export async function assertPinFree(db, pin, exceptId) {
  const { data, error } = await db.from('pin_accounts').select('id, pin_hash');
  if (error) throw new Error('Could not save that PIN.');
  for (const row of data || []) {
    if (exceptId && row.id === exceptId) continue;
    if (!row || !row.pin_hash) continue;
    let match = false;
    try { match = bcrypt.compareSync(String(pin), row.pin_hash); } catch { match = false; }
    if (match) throw new Error(PIN_IN_USE);
  }
}
