/**
 * Vocabulary for the platform "Central data" view (docs/ADMIN_GUIDE.md). Each product module exposes one small listing
 * function in these terms; the `central` module merges them across organisations. Types and one generic helper only, no business rules.
 */
export interface CentralFilters {
  /** lead stage / student status / application status / document status */
  status?: string;
  /** name or phone (documents: the student's name or phone) */
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  /** staff user ids the record is assigned to (already resolved by the caller). Not used by documents of unassigned students. */
  assignedTo?: string[];
}

export interface CentralPageOf<T> {
  /** the first `take` rows of this organisation, newest first (createdAt desc, id desc) */
  items: T[];
  /** how many rows match in this organisation (all of them, not only `take`) */
  total: number;
}

/** createdAt range as a Mongo condition, or undefined when no range was given. */
export const createdRange = (f: Pick<CentralFilters, 'createdFrom' | 'createdTo'>): Record<string, Date> | undefined => {
  if (!f.createdFrom && !f.createdTo) return undefined;
  return { ...(f.createdFrom ? { $gte: f.createdFrom } : {}), ...(f.createdTo ? { $lte: f.createdTo } : {}) };
};

/** Escape user text for use inside a RegExp. */
export const escapeForRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
