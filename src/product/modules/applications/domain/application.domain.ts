/** Pure rules for applications: the status machine. Unit-tested in tests/applications.domain.test.ts */

export const STATUSES = [
  'draft',
  'documents_pending',
  'ready_to_submit',
  'submitted',
  'under_review',
  'offered',
  'rejected',
  'accepted',
  'declined',
  'fee_paid',
  'admitted',
  'withdrawn',
] as const;
export type ApplicationStatus = (typeof STATUSES)[number];

export const TERMINAL: readonly ApplicationStatus[] = ['admitted', 'rejected', 'declined', 'withdrawn'];

const FORWARD: Record<ApplicationStatus, ApplicationStatus[]> = {
  draft: ['documents_pending'],
  documents_pending: ['ready_to_submit'],
  ready_to_submit: ['submitted'],
  submitted: ['under_review'],
  under_review: ['offered', 'rejected'],
  offered: ['accepted', 'declined'],
  accepted: ['fee_paid'],
  fee_paid: ['admitted'],
  admitted: [],
  rejected: [],
  declined: [],
  withdrawn: [],
};

export const isStatus = (s: string): s is ApplicationStatus => (STATUSES as readonly string[]).includes(s);
export const isTerminal = (s: ApplicationStatus): boolean => TERMINAL.includes(s);

/** Statuses an application may move to from `from` (withdrawn is allowed from any non-terminal state). */
export const nextStatuses = (from: ApplicationStatus): ApplicationStatus[] => (isTerminal(from) ? [] : [...FORWARD[from], 'withdrawn']);

export const canTransition = (from: ApplicationStatus, to: ApplicationStatus): boolean => nextStatuses(from).includes(to);

/** Plain-language reason when the move is not allowed, else null. */
export const transitionProblem = (from: ApplicationStatus, to: ApplicationStatus): string | null => {
  if (canTransition(from, to)) return null;
  if (isTerminal(from)) return `This application is already ${from.replace(/_/g, ' ')} and cannot change any more.`;
  const allowed = nextStatuses(from).map((s) => s.replace(/_/g, ' ')).join(', ');
  return `An application cannot go from ${from.replace(/_/g, ' ')} to ${to.replace(/_/g, ' ')}. Allowed next: ${allowed}.`;
};

/** Statuses where the amount paid may be recorded. */
export const FEE_STATUSES: readonly ApplicationStatus[] = ['accepted', 'fee_paid', 'admitted'];
export const canRecordFee = (to: ApplicationStatus): boolean => FEE_STATUSES.includes(to);
