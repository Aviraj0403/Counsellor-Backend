/** Pure rules for follow-ups. No database, no HTTP: unit-tested in tests/followups.domain.test.ts */

export const ENTITY_TYPES = ['lead', 'student', 'application'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const ACTIVITY_KINDS = ['call', 'whatsapp', 'email', 'meeting', 'note', 'system'] as const;
export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export const DUE_FILTERS = ['today', 'overdue', 'week'] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];

const DAY = 24 * 60 * 60 * 1000;

/** Start of the calendar day in UTC. The admin shows times in local time; "today" is the server's day. */
export const startOfDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Mongo-ready dueAt range for a due filter. overdue = before now; today = rest of today (from start of day); week = next 7 days. */
export const dueRange = (due: DueFilter, now: Date): { $gte?: Date; $lt?: Date } => {
  const day = startOfDay(now);
  if (due === 'overdue') return { $lt: now };
  if (due === 'today') return { $gte: day, $lt: new Date(day.getTime() + DAY) };
  return { $gte: day, $lt: new Date(day.getTime() + 7 * DAY) };
};

export const isOverdue = (task: { status: string; dueAt: Date }, now: Date): boolean => task.status === 'open' && task.dueAt.getTime() < now.getTime();

/** A task to contact a newly assigned lead is due one hour later. */
export const CONTACT_TASK_TITLE = 'Contact new lead';
export const contactDueAt = (now: Date): Date => new Date(now.getTime() + 60 * 60 * 1000);

export const describeStageChange = (from: string, to: string): string => `Stage changed from ${from} to ${to}`;
export const describeLeadCreated = (channel: string): string => `Lead created via ${channel}`;
