/** Pure rules for appointments. No database, no HTTP: unit-tested in tests/appointments.domain.test.ts */

export const MODES = ['phone', 'video', 'in_person'] as const;
export const ASSIGNMENTS = ['specific', 'round_robin'] as const;
export const STATUSES = ['booked', 'confirmed', 'completed', 'cancelled', 'no_show', 'rescheduled'] as const;
export const SOURCES = ['staff', 'public', 'bot', 'portal'] as const;
export type AppointmentStatus = (typeof STATUSES)[number];
export type AppointmentSource = (typeof SOURCES)[number];

/** Statuses that occupy the counsellor's time (and the unique index). */
export const ACTIVE_STATUSES: readonly AppointmentStatus[] = ['booked', 'confirmed'];
export const isActive = (s: string): boolean => (ACTIVE_STATUSES as readonly string[]).includes(s);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** India has one timezone and no daylight saving: IST = UTC+05:30 all year. All working hours are IST wall-clock times. */
export const IST_OFFSET_MIN = 330;
const IST_MS = IST_OFFSET_MIN * MIN;

/** Midnight (IST) of the IST calendar day containing this instant, as a UTC instant. */
export const istDayStart = (d: Date): Date => new Date(Math.floor((d.getTime() + IST_MS) / DAY) * DAY - IST_MS);
/** 0 = Sunday ... 6 = Saturday, in IST. */
export const istWeekday = (d: Date): number => new Date(d.getTime() + IST_MS).getUTCDay();
/** The UTC instant of "HH:MM" on the IST day that starts at dayStart. */
export const istTimeOnDay = (dayStart: Date, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(dayStart.getTime() + (h! * 60 + m!) * MIN);
};

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export interface Range { start: string; end: string }
export interface WeeklyDay { day: number; ranges: Range[] }

/** Plain-language problem with a weekly schedule, or null when it is fine. */
export const weeklyProblem = (weekly: WeeklyDay[]): string | null => {
  const seen = new Set<number>();
  for (const d of weekly) {
    if (!Number.isInteger(d.day) || d.day < 0 || d.day > 6) return 'Day must be 0 (Sunday) to 6 (Saturday).';
    if (seen.has(d.day)) return 'Each day can appear only once.';
    seen.add(d.day);
    const sorted = [...d.ranges].sort((a, b) => toMin(a.start) - toMin(b.start));
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i]!;
      if (!HHMM.test(r.start) || !HHMM.test(r.end)) return 'Times must look like 09:30.';
      if (toMin(r.end) <= toMin(r.start)) return `A working range must end after it starts (${r.start}-${r.end}).`;
      if (i > 0 && toMin(r.start) < toMin(sorted[i - 1]!.end)) return 'Working ranges on the same day must not overlap.';
    }
  }
  return null;
};

export interface SlotType {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeHours: number;
  maxAdvanceDays: number;
  slotStepMin: number;
}
export interface BusyAppointment { start: Date; end: Date; bufferBeforeMin?: number; bufferAfterMin?: number }
export interface TimeOffRange { from: Date; to: Date }
export interface Slot { start: Date; end: Date }

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

/**
 * Free slots of ONE counsellor, in UTC.
 *  - working hours are IST weekly ranges; a slot must fit completely inside one range
 *  - starts are on the type's step, counted from the start of each range
 *  - the appointment plus its own buffers must not touch an existing active appointment (which also keeps its own buffers)
 *  - time off removes any slot that overlaps it
 *  - nothing earlier than now + minNoticeHours, nothing later than now + maxAdvanceDays (so the past is never offered)
 *  - only slots that START in [from, to) are returned
 */
export const computeSlots = (a: {
  type: SlotType;
  hours: WeeklyDay[];
  timeOff: TimeOffRange[];
  existing: BusyAppointment[];
  now: Date;
  from: Date;
  to: Date;
}): Slot[] => {
  const { type, hours, timeOff, existing, now, from, to } = a;
  if (to.getTime() <= from.getTime()) return [];
  const earliest = Math.max(from.getTime(), now.getTime() + type.minNoticeHours * HOUR);
  const latest = Math.min(to.getTime() - 1, now.getTime() + type.maxAdvanceDays * DAY);
  if (latest < earliest) return [];
  const dur = type.durationMin * MIN;
  const step = Math.max(1, type.slotStepMin) * MIN;
  const before = type.bufferBeforeMin * MIN;
  const after = type.bufferAfterMin * MIN;
  const byDay = new Map(hours.map((h) => [h.day, h.ranges]));
  const out: Slot[] = [];

  for (let day = istDayStart(new Date(earliest)).getTime(); day <= latest; day += DAY) {
    const ranges = byDay.get(istWeekday(new Date(day + 12 * HOUR))) ?? [];
    for (const r of ranges) {
      const rStart = istTimeOnDay(new Date(day), r.start).getTime();
      const rEnd = istTimeOnDay(new Date(day), r.end).getTime();
      for (let t = rStart; t + dur <= rEnd; t += step) {
        if (t < earliest || t > latest) continue;
        const end = t + dur;
        if (timeOff.some((o) => overlaps(t, end, o.from.getTime(), o.to.getTime()))) continue;
        const wantStart = t - before;
        const wantEnd = end + after;
        const clash = existing.some((e) =>
          overlaps(wantStart, wantEnd, e.start.getTime() - (e.bufferBeforeMin ?? 0) * MIN, e.end.getTime() + (e.bufferAfterMin ?? 0) * MIN),
        );
        if (clash) continue;
        out.push({ start: new Date(t), end: new Date(end) });
      }
    }
  }
  return out.sort((x, y) => x.start.getTime() - y.start.getTime());
};

/** Round-robin: the counsellor with the fewest appointments in the next 7 days; a tie goes to the lowest id. */
export const pickRoundRobin = (candidates: { counsellorId: string; booked: number }[]): string | null => {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => a.booked - b.booked || (a.counsellorId < b.counsellorId ? -1 : a.counsellorId > b.counsellorId ? 1 : 0))[0]!.counsellorId;
};

/** A booker may cancel or move an appointment only until `cancellationNoticeHours` before it starts. */
export const canCancel = (type: { cancellationNoticeHours: number }, start: Date, now: Date): boolean =>
  start.getTime() - now.getTime() >= type.cancellationNoticeHours * HOUR;

const NEXT: Record<AppointmentStatus, AppointmentStatus[]> = {
  booked: ['confirmed', 'completed', 'cancelled', 'no_show', 'rescheduled'],
  confirmed: ['completed', 'cancelled', 'no_show', 'rescheduled'],
  completed: [],
  cancelled: [],
  no_show: [],
  rescheduled: [],
};
export const nextStatuses = (from: string): AppointmentStatus[] => NEXT[from as AppointmentStatus] ?? [];
export const validateTransition = (from: string, to: string): boolean => nextStatuses(from).includes(to as AppointmentStatus);

/** "No-show" and "completed" describe something that already happened. */
export const hasStarted = (start: Date, now: Date): boolean => start.getTime() <= now.getTime();

export interface ReminderEntry { offsetMin: number; sentAt?: Date | null }

/** Reminder rows for a new appointment: only offsets that are still in the future (no "24 h before" for a booking made 1 h before). */
export const initialReminderState = (offsets: number[], start: Date, now: Date): ReminderEntry[] =>
  [...new Set(offsets)].filter((o) => start.getTime() - o * MIN > now.getTime()).map((offsetMin) => ({ offsetMin }));

/** Offsets whose time has come, not sent yet, for an appointment that is still ahead. */
export const reminderDue = (a: { status: string; start: Date; reminderState: ReminderEntry[] }, now: Date): number[] => {
  if (!isActive(a.status) || a.start.getTime() <= now.getTime()) return [];
  return a.reminderState.filter((r) => !r.sentAt && a.start.getTime() - r.offsetMin * MIN <= now.getTime()).map((r) => r.offsetMin);
};

/** Under-18 bookers need a guardian: answers carry `age` (number) or `isUnder18` ('yes'/'true'). */
export const isMinor = (answers: Record<string, string> | undefined): boolean => {
  if (!answers) return false;
  const flag = (answers.isUnder18 ?? '').toLowerCase();
  if (['yes', 'true', '1'].includes(flag)) return true;
  const age = Number(answers.age);
  return Number.isFinite(age) && answers.age !== '' && age > 0 && age < 18;
};
export const guardianProblem = (answers: Record<string, string> | undefined): string | null => {
  if (!isMinor(answers)) return null;
  if (!answers?.guardianName?.trim() || !answers?.guardianPhone?.trim()) return 'Because the student is under 18, a parent or guardian name and phone number are needed.';
  return null;
};

export const missingAnswers = (questions: { key: string; label: string; required?: boolean }[], answers: Record<string, string> | undefined): string[] =>
  questions.filter((q) => q.required && !(answers?.[q.key] ?? '').trim()).map((q) => q.label);
