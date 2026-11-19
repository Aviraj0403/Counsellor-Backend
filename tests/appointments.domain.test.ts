import { describe, expect, it } from 'vitest';
import {
  canCancel, computeSlots, guardianProblem, initialReminderState, isMinor, istDayStart, istWeekday, missingAnswers, nextStatuses, pickRoundRobin, reminderDue, validateTransition, weeklyProblem,
  type SlotType, type WeeklyDay,
} from '../src/product/modules/appointments/domain/appointment.domain.js';

const type: SlotType = { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeHours: 2, maxAdvanceDays: 30, slotStepMin: 30, };
// Wed 2026-11-18 is a Wednesday (day 3). IST 09:00 = 03:30Z.
const NOW = new Date('2026-11-18T02:00:00Z'); // 07:30 IST on Wed
const wed10to12: WeeklyDay[] = [{ day: 3, ranges: [{ start: '10:00', end: '12:00' }] }];
const iso = (d: Date) => d.toISOString();
const run = (over: Partial<Parameters<typeof computeSlots>[0]> = {}) =>
  computeSlots({ type, hours: wed10to12, timeOff: [], existing: [], now: NOW, from: new Date('2026-11-18T00:00:00Z'), to: new Date('2026-11-19T00:00:00Z'), ...over });

describe('IST helpers', () => {
  it('IST midnight is 18:30Z of the previous UTC day', () => {
    expect(iso(istDayStart(new Date('2026-11-18T20:00:00Z')))).toBe('2026-11-18T18:30:00.000Z'); // 01:30 IST on the 19th
    expect(iso(istDayStart(new Date('2026-11-18T18:29:59Z')))).toBe('2026-11-17T18:30:00.000Z');
  });
  it('weekday is taken in IST, not UTC', () => {
    expect(istWeekday(new Date('2026-11-18T19:00:00Z'))).toBe(4); // already Thursday in India
    expect(istWeekday(new Date('2026-11-18T10:00:00Z'))).toBe(3);
  });
});

describe('computeSlots', () => {
  it('turns IST working hours into UTC slots on the step', () => {
    const s = run();
    expect(s.map((x) => iso(x.start))).toEqual(['2026-11-18T04:30:00.000Z', '2026-11-18T05:00:00.000Z', '2026-11-18T05:30:00.000Z', '2026-11-18T06:00:00.000Z']);
    expect(iso(s[0]!.end)).toBe('2026-11-18T05:00:00.000Z');
  });
  it('a slot must fit completely inside the range', () => {
    const s = run({ type: { ...type, durationMin: 45, slotStepMin: 15 } });
    expect(iso(s[s.length - 1]!.end)).toBe('2026-11-18T06:30:00.000Z'); // 12:00 IST
  });
  it('only offers days the counsellor works', () => {
    expect(run({ hours: [{ day: 4, ranges: [{ start: '10:00', end: '11:00' }] }] })).toEqual([]);
  });
  it('an IST day boundary: an evening-IST slot that is the next UTC day still lands on the right IST weekday', () => {
    // Thursday 00:30-01:30 IST = Wednesday 19:00-20:00Z
    const s = run({ hours: [{ day: 4, ranges: [{ start: '00:30', end: '01:30' }] }], from: new Date('2026-11-18T12:00:00Z'), to: new Date('2026-11-19T12:00:00Z') });
    expect(s.map((x) => iso(x.start))).toEqual(['2026-11-18T19:00:00.000Z', '2026-11-18T19:30:00.000Z']);
  });
  it('from/to bound the slot START', () => {
    const s = run({ from: new Date('2026-11-18T05:00:00Z'), to: new Date('2026-11-18T05:30:00Z') });
    expect(s.map((x) => iso(x.start))).toEqual(['2026-11-18T05:00:00.000Z']);
  });
  it('minimum notice hides near slots', () => {
    const now = new Date('2026-11-18T03:30:00Z'); // 09:00 IST; +2 h = 11:00 IST = 05:30Z
    expect(run({ now }).map((x) => iso(x.start))).toEqual(['2026-11-18T05:30:00.000Z', '2026-11-18T06:00:00.000Z']);
  });
  it('the past is never offered, even with zero notice', () => {
    const now = new Date('2026-11-18T05:10:00Z');
    const s = run({ now, type: { ...type, minNoticeHours: 0 } });
    expect(s.map((x) => iso(x.start))).toEqual(['2026-11-18T05:30:00.000Z', '2026-11-18T06:00:00.000Z']);
  });
  it('booking horizon cuts off far-future days', () => {
    const wholeMonth = { from: new Date('2026-11-18T00:00:00Z'), to: new Date('2026-12-30T00:00:00Z') };
    const s = run({ ...wholeMonth, type: { ...type, maxAdvanceDays: 8 } });
    // Wednesdays within 8 days of 18 Nov 07:30 IST: the 18th and the 25th only
    expect(new Set(s.map((x) => iso(x.start).slice(0, 10)))).toEqual(new Set(['2026-11-18', '2026-11-25']));
  });
  it('time off removes every overlapping slot', () => {
    const s = run({ timeOff: [{ from: new Date('2026-11-18T05:10:00Z'), to: new Date('2026-11-18T05:40:00Z') }] });
    expect(s.map((x) => iso(x.start))).toEqual(['2026-11-18T04:30:00.000Z', '2026-11-18T06:00:00.000Z']);
  });
  it('an existing appointment blocks overlapping slots but not touching ones', () => {
    const s = run({ existing: [{ start: new Date('2026-11-18T05:00:00Z'), end: new Date('2026-11-18T05:30:00Z') }] });
    expect(s.map((x) => iso(x.start))).toEqual(['2026-11-18T04:30:00.000Z', '2026-11-18T05:30:00.000Z', '2026-11-18T06:00:00.000Z']);
  });
  it('a longer appointment on a finer step overlaps neighbours at any offset', () => {
    const s = run({ type: { ...type, durationMin: 60, slotStepMin: 15 }, existing: [{ start: new Date('2026-11-18T05:00:00Z'), end: new Date('2026-11-18T06:00:00Z') }] });
    expect(s).toEqual([]); // every 60-minute window inside 10:00-12:00 IST touches the 05:00-06:00Z booking
  });
  it('buffers before and after the new appointment keep it away from neighbours', () => {
    const existing = [{ start: new Date('2026-11-18T05:00:00Z'), end: new Date('2026-11-18T05:30:00Z') }];
    const s = run({ existing, type: { ...type, bufferBeforeMin: 15, bufferAfterMin: 15 } });
    // 04:30-05:00 would end at 05:00 but needs 15 min after => clash; 05:30 needs 15 min before => clash; 06:00 is the first free
    expect(s.map((x) => iso(x.start))).toEqual(['2026-11-18T06:00:00.000Z']);
  });
  it('an existing appointment keeps its own buffers too', () => {
    const existing = [{ start: new Date('2026-11-18T05:00:00Z'), end: new Date('2026-11-18T05:30:00Z'), bufferAfterMin: 30 }];
    const s = run({ existing });
    expect(s.map((x) => iso(x.start))).toEqual(['2026-11-18T04:30:00.000Z', '2026-11-18T06:00:00.000Z']);
  });
  it('buffers may reach outside working hours, the appointment itself may not', () => {
    const s = run({ type: { ...type, bufferBeforeMin: 30, bufferAfterMin: 30 } });
    expect(s).toHaveLength(4);
  });
  it('returns nothing for an empty or reversed window', () => {
    expect(run({ from: new Date('2026-11-19T00:00:00Z'), to: new Date('2026-11-18T00:00:00Z') })).toEqual([]);
  });
  it('supports several ranges in a day (lunch break)', () => {
    const s = run({ hours: [{ day: 3, ranges: [{ start: '10:00', end: '10:30' }, { start: '14:00', end: '14:30' }] }] });
    expect(s.map((x) => iso(x.start))).toEqual(['2026-11-18T04:30:00.000Z', '2026-11-18T08:30:00.000Z']);
  });
});

describe('weeklyProblem', () => {
  it('accepts a good schedule and explains bad ones', () => {
    expect(weeklyProblem(wed10to12)).toBeNull();
    expect(weeklyProblem([{ day: 9, ranges: [] }])).toMatch(/Day must be/);
    expect(weeklyProblem([{ day: 1, ranges: [{ start: '11:00', end: '10:00' }] }])).toMatch(/end after/);
    expect(weeklyProblem([{ day: 1, ranges: [{ start: '09:00', end: '11:00' }, { start: '10:00', end: '12:00' }] }])).toMatch(/overlap/);
    expect(weeklyProblem([{ day: 1, ranges: [] }, { day: 1, ranges: [] }])).toMatch(/only once/);
  });
});

describe('pickRoundRobin', () => {
  it('chooses the least booked counsellor, ties go to the lowest id', () => {
    expect(pickRoundRobin([{ counsellorId: 'b', booked: 2 }, { counsellorId: 'a', booked: 3 }, { counsellorId: 'c', booked: 1 }])).toBe('c');
    expect(pickRoundRobin([{ counsellorId: 'b', booked: 1 }, { counsellorId: 'a', booked: 1 }])).toBe('a');
    expect(pickRoundRobin([])).toBeNull();
  });
});

describe('cancellation window', () => {
  const t = { cancellationNoticeHours: 4 };
  const start = new Date('2026-11-18T10:00:00Z');
  it('allowed up to the notice limit, refused inside it', () => {
    expect(canCancel(t, start, new Date('2026-11-18T06:00:00Z'))).toBe(true);
    expect(canCancel(t, start, new Date('2026-11-18T06:00:01Z'))).toBe(false);
    expect(canCancel(t, start, new Date('2026-11-18T11:00:00Z'))).toBe(false);
  });
});

describe('status transitions', () => {
  it('booked can go to every outcome', () => {
    expect(nextStatuses('booked').sort()).toEqual(['cancelled', 'completed', 'confirmed', 'no_show', 'rescheduled']);
    expect(validateTransition('booked', 'confirmed')).toBe(true);
    expect(validateTransition('confirmed', 'cancelled')).toBe(true);
  });
  it('terminal states are fixed and nothing goes back', () => {
    for (const s of ['completed', 'cancelled', 'no_show', 'rescheduled']) expect(nextStatuses(s)).toEqual([]);
    expect(validateTransition('cancelled', 'booked')).toBe(false);
    expect(validateTransition('confirmed', 'booked')).toBe(false);
    expect(validateTransition('booked', 'booked')).toBe(false);
    expect(validateTransition('nonsense', 'booked')).toBe(false);
  });
});

describe('reminders', () => {
  const start = new Date('2026-11-20T10:00:00Z');
  it('a booking made close to the start gets no reminder that is already in the past', () => {
    const s = initialReminderState([1440, 120], start, new Date('2026-11-20T04:00:00Z')); // 6 h before
    expect(s).toEqual([{ offsetMin: 120 }]);
  });
  it('is due once its time has come, not before, never after the start', () => {
    const a = { status: 'booked', start, reminderState: [{ offsetMin: 1440 }, { offsetMin: 120 }] };
    expect(reminderDue(a, new Date('2026-11-19T09:59:00Z'))).toEqual([]);
    expect(reminderDue(a, new Date('2026-11-19T10:00:00Z'))).toEqual([1440]);
    expect(reminderDue(a, new Date('2026-11-20T08:30:00Z'))).toEqual([1440, 120]);
    expect(reminderDue(a, new Date('2026-11-20T10:00:00Z'))).toEqual([]);
  });
  it('sent reminders and inactive appointments are skipped', () => {
    expect(reminderDue({ status: 'booked', start, reminderState: [{ offsetMin: 120, sentAt: new Date() }] }, new Date('2026-11-20T09:00:00Z'))).toEqual([]);
    expect(reminderDue({ status: 'cancelled', start, reminderState: [{ offsetMin: 120 }] }, new Date('2026-11-20T09:00:00Z'))).toEqual([]);
  });
});

describe('minors and intake', () => {
  it('detects under-18 from age or a yes flag and asks for a guardian', () => {
    expect(isMinor({ age: '16' })).toBe(true);
    expect(isMinor({ age: '18' })).toBe(false);
    expect(isMinor({ isUnder18: 'Yes' })).toBe(true);
    expect(isMinor({})).toBe(false);
    expect(guardianProblem({ age: '16' })).toMatch(/under 18/);
    expect(guardianProblem({ age: '16', guardianName: 'Mr Rao', guardianPhone: '9876543210' })).toBeNull();
    expect(guardianProblem({ age: '25' })).toBeNull();
  });
  it('lists unanswered required questions by label', () => {
    const qs = [{ key: 'course', label: 'Course', required: true }, { key: 'city', label: 'City' }];
    expect(missingAnswers(qs, {})).toEqual(['Course']);
    expect(missingAnswers(qs, { course: ' ' })).toEqual(['Course']);
    expect(missingAnswers(qs, { course: 'BBA' })).toEqual([]);
  });
});
