import { z } from 'zod';
import { BUDGET_BANDS, STAGES, TIMELINES } from '../domain/bots.domain.js';

/**
 * The ONLY tools the assistant has. No tool takes an organisation id or a student id: the service supplies the current
 * conversation's organisation, so the model can never reach another organisation's or another student's data.
 * Every argument set is validated with zod (strict: unknown keys are rejected), whatever the model sends.
 */
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'not a valid id');
const text = (n: number) => z.string().trim().min(1).max(n);

export const TOOL_SCHEMAS = {
  search_colleges: z.object({ query: text(80).optional(), city: text(60).optional(), state: text(60).optional(), limit: z.number().int().min(1).max(8).optional() }).strict(),
  get_course_details: z.object({ collegeId: objectId, courseId: objectId.optional() }).strict(),
  get_available_slots: z
    .object({ typeId: objectId.optional(), fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD').optional(), days: z.number().int().min(1).max(14).optional() })
    .strict(),
  book_appointment: z
    .object({ typeId: objectId, start: z.string().datetime({ offset: true }), name: text(80), phone: text(20), email: z.string().trim().email().max(120).optional() })
    .strict(),
  capture_lead: z
    .object({
      name: text(80).optional(),
      phone: text(20).optional(),
      email: z.string().trim().email().max(120).optional(),
      city: text(60).optional(),
      course: text(100).optional(),
      stage: z.enum(STAGES).optional(),
      budgetBand: z.enum(BUDGET_BANDS).optional(),
      percentage: z.number().min(0).max(100).optional(),
      timeline: z.enum(TIMELINES).optional(),
      language: z.enum(['en', 'hi', 'hinglish']).optional(),
      guardianName: text(80).optional(),
      guardianPhone: text(20).optional(),
      guardianConsent: z.boolean().optional(),
    })
    .strict(),
  request_human: z.object({ reason: text(200) }).strict(),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];
export const isToolName = (n: string): n is ToolName => Object.prototype.hasOwnProperty.call(TOOL_SCHEMAS, n);

export type ParsedTool<N extends ToolName = ToolName> = { ok: true; name: N; args: z.infer<(typeof TOOL_SCHEMAS)[N]> } | { ok: false; error: string };

/** Unknown tool or bad arguments = a plain error the model can read; nothing runs. */
export const parseToolCall = (name: string, input: unknown): ParsedTool => {
  if (!isToolName(name)) return { ok: false, error: `There is no tool called "${name.slice(0, 40)}". Available tools: ${TOOL_NAMES.join(', ')}.` };
  const r = TOOL_SCHEMAS[name].safeParse(input ?? {});
  if (!r.success) return { ok: false, error: `Invalid arguments for ${name}: ${r.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}` };
  return { ok: true, name, args: r.data as any };
};

/** Tool definitions in the Messages API shape. */
export const TOOL_DEFS = [
  {
    name: 'search_colleges',
    description: 'Search the organisation\'s own list of colleges by name, city or state. Returns name, city, type, affiliation and a short description. This is the ONLY source for what colleges exist.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 8 } }, additionalProperties: false },
  },
  {
    name: 'get_course_details',
    description: 'Get the courses of one college (fees, duration, intake deadlines, eligibility) or one course. The ONLY source for fees, deadlines and eligibility; quote it exactly. Needs ids returned by search_colleges.',
    input_schema: { type: 'object', properties: { collegeId: { type: 'string' }, courseId: { type: 'string' } }, required: ['collegeId'], additionalProperties: false },
  },
  {
    name: 'get_available_slots',
    description: 'List bookable counselling appointment types, or (with typeId) the free slots in the next days. Times are shown in IST.',
    input_schema: { type: 'object', properties: { typeId: { type: 'string' }, fromDate: { type: 'string', description: 'YYYY-MM-DD' }, days: { type: 'integer', minimum: 1, maximum: 14 } }, additionalProperties: false },
  },
  {
    name: 'book_appointment',
    description: 'Book one of the slots returned by get_available_slots, only after the student gave their name and phone number and agreed to the slot. `start` must be the exact ISO time of the slot.',
    input_schema: {
      type: 'object',
      properties: { typeId: { type: 'string' }, start: { type: 'string', description: 'ISO 8601 start time of the slot' }, name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } },
      required: ['typeId', 'start', 'name', 'phone'],
      additionalProperties: false,
    },
  },
  {
    name: 'capture_lead',
    description: 'Save what the student told you (only facts they typed). Call it whenever you learn a new fact, and when you have their name and phone. For a student under 18, also pass the guardian\'s name, phone and whether the guardian agreed.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, city: { type: 'string' }, course: { type: 'string' },
        stage: { type: 'string', enum: [...STAGES] }, budgetBand: { type: 'string', enum: [...BUDGET_BANDS], description: 'yearly budget in INR' },
        percentage: { type: 'number' }, timeline: { type: 'string', enum: [...TIMELINES] }, language: { type: 'string', enum: ['en', 'hi', 'hinglish'] },
        guardianName: { type: 'string' }, guardianPhone: { type: 'string' }, guardianConsent: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'request_human',
    description: 'Hand the conversation to a human counsellor: when you are unsure, cannot answer from tool results, the student is upset, or asks for a person.',
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false },
  },
] as const;
