import type { ModuleConfigStatus } from '../../../../shared/kernel/configStatus.js';
import { InviteModel } from '../infrastructure/invite.model.js';

/** Counts of active portal logins only: never names or e-mails. */
const status = (kind: 'student' | 'college', noun: string, nextStep: string) => async (tenantId: string): Promise<ModuleConfigStatus> => {
  const active = await InviteModel(tenantId).countDocuments({ kind, status: 'active' });
  const items = [{ label: `Active ${noun} logins`, value: active }];
  if (active === 0) return { configured: false, health: 'attention', summary: `The ${noun} portal is on but nobody has been invited yet.`, items, nextStep };
  return { configured: true, health: 'ok', summary: `${active} active ${noun} login(s).`, items };
};

export const studentPortalStatus = status('student', 'student', 'Ask the organisation to invite a student from the student profile.');
export const collegePortalStatus = status('college', 'college', 'Ask the organisation to invite a college contact from the college page.');
