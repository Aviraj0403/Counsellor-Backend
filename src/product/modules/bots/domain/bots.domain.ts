/** Pure rules of the AI admissions assistant. No database, no network: everything here is unit-tested. */

export const CHANNELS = ['web', 'whatsapp', 'staff_test'] as const;
export type Channel = (typeof CHANNELS)[number];
export const STATUSES = ['open', 'handed_off', 'closed'] as const;
export type ConvStatus = (typeof STATUSES)[number];
export const BANDS = ['hot', 'warm', 'cold'] as const;
export type Band = (typeof BANDS)[number];

export const MAX_MESSAGE_CHARS = 1000;
export const MAX_REPLY_CHARS = 1200;
export const MAX_STORED_MESSAGES = 80;
export const HISTORY_WINDOW = 16;

export const STAGES = ['class_10', 'class_12', 'diploma', 'graduate', 'working', 'other'] as const;
export const BUDGET_BANDS = ['under_1l', '1_3l', '3_6l', 'above_6l', 'flexible'] as const;
export const TIMELINES = ['immediate', 'within_3_months', '3_to_6_months', 'later', 'exploring'] as const;

export interface Qualification {
  course?: string;
  stage?: string;
  budgetBand?: string;
  city?: string;
  percentage?: number;
  timeline?: string;
}

export interface ScoreInput {
  qualification: Qualification;
  /** a booking was made through the bot (the phone number was given for a real appointment) */
  bookedAppointment?: boolean;
  /** the student asked for a counsellor / human */
  askedForCounsellor?: boolean;
}

/** Points are fixed and published here. The model only extracts the fields; the score is never decided by the model. */
export const SCORE_POINTS = { course: 20, stage: 5, percentage: 15, budget: 15, city: 5, timeline: 20, booked: 10, asked: 10 } as const;

export const scoreQualification = (input: ScoreInput): { score: number; band: Band; reasons: string[] } => {
  const q = input.qualification;
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, why: string) => {
    score += points;
    reasons.push(`+${points} ${why}`);
  };
  if (q.course?.trim()) add(SCORE_POINTS.course, 'course chosen');
  if (q.stage?.trim()) add(SCORE_POINTS.stage, 'education stage known');
  if (typeof q.percentage === 'number' && q.percentage >= 0 && q.percentage <= 100) add(SCORE_POINTS.percentage, 'percentage known');
  if (q.budgetBand?.trim()) add(SCORE_POINTS.budget, 'budget stated');
  if (q.city?.trim()) add(SCORE_POINTS.city, 'city known');
  if (q.timeline === 'immediate' || q.timeline === 'within_3_months') add(SCORE_POINTS.timeline, 'plans to join within 3 months');
  if (input.bookedAppointment) add(SCORE_POINTS.booked, 'booked a counselling slot (phone given)');
  if (input.askedForCounsellor) add(SCORE_POINTS.asked, 'asked for a counsellor');
  score = Math.min(100, score);
  return { score, band: score >= 65 ? 'hot' : score >= 35 ? 'warm' : 'cold', reasons };
};

// ---------------------------------------------------------------- privacy: masking

const EMAIL = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi;
const PHONE = /(?<![\d])(?:\+?91[\s-]?)?[6-9](?:[\s-]?\d){9}(?![\d])/g;
const LONG_DIGITS = /(?<![\d])\d(?:[\s-]?\d){11,18}(?![\d])/g; // Aadhaar (12), cards (13-19)

export interface KeepValues {
  phones?: string[]; // normalised +91... numbers that already live in a lead field
  emails?: string[];
}

const digitsOf = (s: string) => s.replace(/\D/g, '');
const last10 = (s: string) => digitsOf(s).slice(-10);

/**
 * Text stored in the transcript: phone numbers, e-mails and ID/card-like digit runs are masked unless they are already
 * a lead field (then the lead holds the real value and the transcript may repeat it).
 */
export const maskPii = (text: string, keep: KeepValues = {}): string => {
  const keepPhones = new Set((keep.phones ?? []).map(last10));
  const keepEmails = new Set((keep.emails ?? []).map((e) => e.toLowerCase()));
  // 12+ digit runs first (an Aadhaar number must not be half-eaten by the phone pattern)
  let out = text.replace(LONG_DIGITS, (m) => {
    const d = digitsOf(m);
    return d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d.slice(2)) && keepPhones.has(d.slice(-10)) ? m : '[number removed]';
  });
  out = out.replace(PHONE, (m) => (keepPhones.has(last10(m)) ? m : `[phone ***${last10(m).slice(-3)}]`));
  out = out.replace(EMAIL, (m, domain: string) => (keepEmails.has(m.toLowerCase()) ? m : `[email ***@${domain}]`));
  return out;
};

// ---------------------------------------------------------------- minors (DPDP)

export interface MinorSignal {
  suspected: boolean;
  age?: number;
  reason?: string;
}

const AGE_PATTERNS: RegExp[] = [
  /\b(?:i\s*am|i'?m|im|age(?:\s+is)?|meri\s+(?:age|umar|umr)(?:\s+hai)?|main|mai|mera\s+age)\s*[:=-]?\s*(\d{1,2})\b(?!\s*(?:th|st|nd|rd|%|percent|marks|lakh|k\b))/i,
  /\b(\d{1,2})\s*(?:years?|yrs?|saal|sal|varsh)(?:\s*(?:old|ka|ki|ke|ki\s+umar))?\b/i,
];

/** Detects an under-18 student from what they typed. Conservative: a hint is enough to ask for a guardian. */
export const detectMinor = (text: string): MinorSignal => {
  const t = text.toLowerCase();
  if (/\b(?:i\s*am|i'?m|im)\s+(?:a\s+)?minor\b|\bunder\s*18\b|\bnabalig\b/.test(t)) return { suspected: true, reason: 'says they are a minor' };
  for (const re of AGE_PATTERNS) {
    const m = re.exec(text);
    const age = m ? Number(m[1]) : NaN;
    if (Number.isFinite(age) && age >= 5 && age < 18) return { suspected: true, age, reason: `age ${age}` };
  }
  const cls = /\b(?:class|std|standard|grade)\s*(?:is\s*)?(?:[-:]\s*)?(\d{1,2})(?:th|st|nd|rd)?\b|\b(\d{1,2})(?:th|st|nd|rd)\s+(?:class|std|standard)\b|\b(?:studying|padh\s*raha|padh\s*rahi|reading)\s+(?:in\s+)?(?:class\s*)?(\d{1,2})(?:th)?\b/i.exec(text);
  const grade = cls ? Number(cls[1] ?? cls[2] ?? cls[3]) : NaN;
  if (Number.isFinite(grade) && grade >= 5 && grade <= 11 && !/\b(?:pass(?:ed)?|completed|done|cleared)\b/i.test(text)) return { suspected: true, reason: `in class ${grade}` };
  return { suspected: false };
};

// ---------------------------------------------------------------- handoff

export const DEFAULT_HANDOFF_KEYWORDS = ['complaint', 'refund', 'legal', 'lawyer', 'consumer court', 'escalate', 'manager'];

const HUMAN_REQUEST = [
  /\b(?:talk|speak|chat|connect|baat)\b.{0,25}\b(?:human|person|agent|counsel+or|executive|representative|someone|insaan|banda|bande)\b/i,
  /\b(?:human|real person|live agent|call me|call back|callback|phone call)\b/i,
  /\bcounsel+or\s+(?:se|ko|se\s+baat|chahiye)\b/i,
  /\b(?:insaan|aadmi)\s+se\b/i,
];
const FRUSTRATION = /\b(?:useless|stupid|idiot|worst|rubbish|nonsense|bakwas|bekar|faltu|waste of time|fraud|cheat(?:er|ing)?|scam|harass(?:ing|ment)?|not helping|you are not understanding|pagal)\b/i;

export type HandoffReason = 'keyword' | 'human_request' | 'frustration' | 'minor_needs_guardian' | 'low_confidence' | 'model_failed' | 'model_refused';

export interface HandoffInput {
  text: string;
  keywords: string[];
  minor?: { suspected: boolean; guardianConsent: boolean };
  /** how many student messages have been sent since the bot first suspected a minor */
  minorTurns?: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rules checked on the student's message BEFORE any model call (so a hand-off costs nothing). */
export const handoffFromMessage = (i: HandoffInput): HandoffReason | null => {
  const t = i.text.toLowerCase();
  for (const k of i.keywords) {
    const kw = k.trim().toLowerCase();
    if (kw && new RegExp(`(?<![a-z0-9])${escapeRe(kw)}(?![a-z0-9])`).test(t)) return 'keyword';
  }
  if (HUMAN_REQUEST.some((re) => re.test(i.text))) return 'human_request';
  if (FRUSTRATION.test(i.text)) return 'frustration';
  // A minor who did not provide a guardian after the bot asked (three further messages) goes to a human.
  if (i.minor?.suspected && !i.minor.guardianConsent && (i.minorTurns ?? 0) >= 4) return 'minor_needs_guardian';
  return null;
};

export const HANDOFF_REPLY: Record<HandoffReason, string> = {
  keyword: 'I am passing this to one of our counsellors, who will contact you shortly.',
  human_request: 'Sure, I am connecting you with a counsellor. They will contact you shortly.',
  frustration: 'I am sorry I could not help well. A counsellor will contact you shortly.',
  minor_needs_guardian: 'Since you may be under 18, a counsellor will talk to your parent or guardian. Please share their name and phone number, or ask them to contact us.',
  low_confidence: 'I am not fully sure about this, so a counsellor will confirm it for you shortly.',
  model_failed: 'I am having trouble right now. A counsellor will contact you shortly.',
  model_refused: 'I cannot help with that here. A counsellor will contact you shortly.',
};

// ---------------------------------------------------------------- output safety

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bcpk_[A-Za-z0-9_]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\bmongodb(?:\+srv)?:\/\/\S+/gi,
  /\b[A-Fa-f0-9]{32,}\b/g, // long hex (keys, hashes)
  /\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/g, // long base64-like run
  /\b(?:password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*\S+/gi,
];

/** What may leave the system to a student: length capped, secrets and internal tags removed. */
export const sanitizeReply = (raw: string, max = MAX_REPLY_CHARS): string => {
  let out = raw.replace(/<\/?(?:thinking|system|tool_use|tool_result|function_calls|antml:[a-z_]+)[^>]*>/gi, '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[removed]');
  out = out.trim();
  if (out.length > max) out = `${out.slice(0, max - 1).trimEnd()}…`;
  return out;
};

// ---------------------------------------------------------------- per-visitor rate limit (pure)

/** Sliding window: true = allowed (and recorded). `buckets` is owned by the caller so tests start clean. */
export const allowRate = (buckets: Map<string, number[]>, key: string, now: number, limit: number, windowMs: number): boolean => {
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
  return true;
};

export const expiryFor = (now: Date, retentionDays: number): Date => new Date(now.getTime() + retentionDays * 86_400_000);

export const monthKey = (d: Date): string => d.toISOString().slice(0, 7);
export const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/** Round-robin by load: the counsellor with the fewest open hand-offs; a tie goes to the lowest id. */
export const pickLeastLoaded = (team: { id: string }[], load: Map<string, number>): string | undefined =>
  [...team].sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || (a.id < b.id ? -1 : 1))[0]?.id;

/** "Mon 24 Nov, 4:30 PM" in Indian time, for chat replies. */
export const formatIst = (d: Date): string =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
