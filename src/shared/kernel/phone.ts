/**
 * Indian mobile numbers only for now. "98765 43210", "+91-98765-43210", "09876543210" all become "+919876543210".
 * Returns null when it is not a valid mobile number. The normalised value is the duplicate-check key for leads and students.
 */
export const normalizePhone = (raw: string): string | null => {
  let d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
};
