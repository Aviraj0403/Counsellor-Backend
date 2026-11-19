import * as colleges from '../../colleges/index.js';
import { appointmentsAdapter } from './appointments.adapter.js';

/**
 * What the assistant reads from other modules, behind small ports so tests can fake them and the rest of the module
 * never depends on how another module is built. Production adapters are at the bottom of this file / appointments.adapter.ts.
 */
export interface CollegeRow {
  id: string;
  name: string;
  type?: string;
  city?: string;
  state?: string;
  affiliation?: string;
  accreditations?: string[];
  description?: string;
  website?: string;
}
export interface CourseRow {
  id: string;
  collegeId: string;
  name: string;
  level?: string;
  stream?: string;
  durationMonths?: number;
  annualFeePaise?: number;
  totalFeePaise?: number;
  intakes?: { month?: number; year?: number; deadline?: Date | string }[];
  eligibility?: { minPercentage?: number; requiredExams?: string[]; notes?: string };
}
export interface CollegesPort {
  listColleges(tenantId: string): Promise<CollegeRow[]>;
  /** null = this deployment cannot list courses (see report: gap in the colleges public API) */
  listCourses(tenantId: string, collegeId: string): Promise<CourseRow[] | null>;
  getCourse(tenantId: string, courseId: string): Promise<CourseRow | null>;
}

export interface BookableType {
  id: string;
  name: string;
  mode: string;
  durationMin: number;
}
export interface SlotRow {
  start: Date;
  end: Date;
  counsellorId: string;
}
export interface BookInput {
  typeId: string;
  start: Date;
  name: string;
  phone: string;
  email?: string;
  answers?: Record<string, string>;
  leadId?: string;
  source: 'staff' | 'public' | 'bot' | 'portal';
  consentGiven: boolean;
}
export interface AppointmentsPort {
  listBookableTypes(tenantId: string): Promise<BookableType[]>;
  getAvailableSlots(tenantId: string, input: { typeId: string; from: Date; to: Date; counsellorId?: string }): Promise<SlotRow[]>;
  bookAppointment(tenantId: string, input: BookInput): Promise<{ id: string; start: Date; end: Date; counsellorId: string; manageToken: string }>;
}

const toCollege = (c: any): CollegeRow => ({
  id: String(c._id),
  name: c.name,
  type: c.type,
  city: c.city,
  state: c.state,
  affiliation: c.affiliation,
  accreditations: c.accreditations,
  description: c.description,
  website: c.website,
});
const toCourse = (c: any): CourseRow => ({
  id: String(c._id),
  collegeId: String(c.collegeId),
  name: c.name,
  level: c.level,
  stream: c.stream,
  durationMonths: c.durationMonths,
  annualFeePaise: c.annualFeePaise,
  totalFeePaise: c.totalFeePaise,
  intakes: c.intakes,
  eligibility: c.eligibility,
});

/**
 * Colleges public API today: listActiveColleges, getCollege, getCourse, getRequiredDocuments. There is no "list the courses of a
 * college" function in index.ts. If one is added later (listActiveCourses(tenantId, collegeId) or listCourses(principal, collegeId))
 * it is picked up here without a code change; until then course lists are unavailable and the bot says a counsellor will confirm.
 */
export const collegesAdapter: CollegesPort = {
  listColleges: async (tenantId) => (await colleges.listActiveColleges(tenantId)).map(toCollege),
  listCourses: async (tenantId, collegeId) => {
    const api = colleges as unknown as Record<string, unknown>;
    const fn = api.listActiveCourses as ((t: string, id: string) => Promise<any[]>) | undefined;
    if (typeof fn === 'function') return (await fn(tenantId, collegeId)).map(toCourse);
    return null;
  },
  getCourse: async (tenantId, courseId) => {
    const c = await colleges.getCourse(tenantId, courseId);
    return c ? toCourse(c) : null;
  },
};

let collegesPort: CollegesPort = collegesAdapter;
export const getCollegesPort = (): CollegesPort => collegesPort;
export const setCollegesPort = (p: CollegesPort | null): void => {
  collegesPort = p ?? collegesAdapter;
};

let appointmentsPort: AppointmentsPort | null = appointmentsAdapter;
/** null = booking unavailable (tests); the production adapter is the default. */
export const getAppointmentsPort = (): AppointmentsPort | null => appointmentsPort;
export const setAppointmentsPort = (p: AppointmentsPort | null): void => {
  appointmentsPort = p;
};
export const resetPorts = (): void => {
  collegesPort = collegesAdapter;
  appointmentsPort = appointmentsAdapter;
};
