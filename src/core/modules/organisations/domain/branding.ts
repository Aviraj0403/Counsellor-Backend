/** Organisation branding rules (pure). Logo = an https URL we only link to; colour = #rrggbb. */
export const LOGO_URL_MAX = 500;
const HEX = /^#[0-9a-fA-F]{6}$/;

export const isValidLogoUrl = (v: string): boolean => {
  if (v.length === 0 || v.length > LOGO_URL_MAX || /\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
};

export const isValidBrandColor = (v: string): boolean => HEX.test(v);
