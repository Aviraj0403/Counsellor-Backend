import type { ModuleConfigStatus } from '../../../../shared/kernel/configStatus.js';
import { CollegeModel, CourseModel } from '../infrastructure/college.model.js';

export const configStatus = async (tenantId: string): Promise<ModuleConfigStatus> => {
  const [colleges, courses] = await Promise.all([CollegeModel(tenantId).countDocuments({ active: true }), CourseModel(tenantId).countDocuments({ active: true })]);
  const items = [
    { label: 'Active colleges', value: colleges },
    { label: 'Active courses', value: courses },
  ];
  if (colleges === 0) return { configured: false, health: 'attention', summary: 'College directory is on but no college has been added yet.', items, nextStep: 'Ask the organisation to add their first college.' };
  if (courses === 0) return { configured: false, health: 'attention', summary: 'Colleges exist but none has a course yet.', items, nextStep: 'Ask the organisation to add courses to their colleges.' };
  return { configured: true, health: 'ok', summary: `${colleges} college(s) and ${courses} course(s).`, items };
};
