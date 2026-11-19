import { describe, expect, it } from 'vitest';
import { STATUSES, canRecordFee, canTransition, isTerminal, nextStatuses, transitionProblem, type ApplicationStatus } from '../src/product/modules/applications/domain/application.domain.js';

describe('application status machine', () => {
  it('follows the happy path one step at a time', () => {
    const path: ApplicationStatus[] = ['draft', 'documents_pending', 'ready_to_submit', 'submitted', 'under_review', 'offered', 'accepted', 'fee_paid', 'admitted'];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
  });
  it('refuses skipping and going backwards', () => {
    expect(canTransition('draft', 'submitted')).toBe(false);
    expect(canTransition('submitted', 'offered')).toBe(false);
    expect(canTransition('offered', 'admitted')).toBe(false);
    expect(canTransition('under_review', 'submitted')).toBe(false);
    expect(transitionProblem('draft', 'admitted')).toMatch(/cannot go from draft to admitted/);
  });
  it('offers branch to accepted/declined, review to offered/rejected', () => {
    expect(nextStatuses('under_review')).toEqual(['offered', 'rejected', 'withdrawn']);
    expect(nextStatuses('offered')).toEqual(['accepted', 'declined', 'withdrawn']);
  });
  it('withdrawn is allowed from every non-terminal state only', () => {
    for (const s of STATUSES) expect(canTransition(s, 'withdrawn')).toBe(!isTerminal(s));
  });
  it('terminal states have no way out', () => {
    for (const s of ['admitted', 'rejected', 'declined', 'withdrawn'] as const) {
      expect(nextStatuses(s)).toEqual([]);
      expect(transitionProblem(s, 'draft')).toMatch(/cannot change any more/);
    }
  });
  it('fee can be recorded only from accepted onwards', () => {
    expect(canRecordFee('accepted')).toBe(true);
    expect(canRecordFee('fee_paid')).toBe(true);
    expect(canRecordFee('offered')).toBe(false);
  });
});
