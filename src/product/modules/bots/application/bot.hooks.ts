import { registerContributor } from '../../../../shared/kernel/hooks.js';
import { subscribe } from '../../../../shared/kernel/events.js';
import { audit } from '../../audit/index.js';
import { getStudent } from '../../students/index.js';
import { ConversationModel } from '../infrastructure/bots.model.js';

/** Link conversations to the student created from their lead, so export and erase can find them. */
const forStudent = async (tenantId: string, studentId: string) => {
  const student = await getStudent(tenantId, studentId).catch(() => null);
  const leadId = (student as any)?.leadId ? String((student as any).leadId) : undefined;
  return { $or: [{ studentId }, ...(leadId ? [{ leadId }] : [])] };
};

export const registerHooks = (): void => {
  registerContributor('student.export', async ({ tenantId, studentId }) => {
    const rows = await ConversationModel(tenantId).find(await forStudent(tenantId, studentId)).sort({ createdAt: 1 }).lean<any[]>();
    return {
      section: 'ai_assistant_conversations',
      data: rows.map((c) => ({
        id: String(c._id),
        channel: c.channel,
        startedAt: c.createdAt,
        status: c.status,
        qualification: c.qualification ?? {},
        guardian: c.guardian ?? null,
        consent: c.consent,
        messages: (c.messages ?? []).map((m: any) => ({ role: m.role, text: m.text, at: m.at })),
      })),
    };
  });
};

export const registerEvents = (): void => {
  subscribe('student.created', async ({ tenantId, studentId, leadId }) => {
    if (leadId) await ConversationModel(tenantId).updateMany({ leadId }, { $set: { studentId } });
  });

  // DPDP erase: the transcript and what the student told the bot are removed; counters and the fact of erasure stay.
  subscribe('student.erased', async ({ tenantId, studentId }) => {
    const filter = await forStudent(tenantId, studentId);
    const r = await ConversationModel(tenantId).updateMany(filter, {
      $set: { messages: [], qualification: {}, guardian: {}, status: 'closed', erasedAt: new Date(), scoreReasons: [] },
      $unset: { leadId: '', language: '', 'handoff.assignedTo': '' },
    });
    if (r.modifiedCount) await audit(tenantId, { action: 'bot.conversations_erased', entity: 'student', entityId: studentId, meta: { conversations: r.modifiedCount } });
  });
};
