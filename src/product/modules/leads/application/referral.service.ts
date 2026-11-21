import type { Principal } from '../../../../contracts/port.js';
import { notFound, badRequest } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import { ReferralModel, ReferralProgramModel, type ReferralStatus } from '../infrastructure/referral.model.js';
import { StudentModel } from '../../students/infrastructure/student.model.js';

export const getReferralConfig = async (tenantId: string) => {
  const Program = ReferralProgramModel(tenantId);
  let prog = await Program.findOne().lean<any>();
  if (!prog) {
    prog = await Program.create({});
    prog = prog.toObject();
  }
  return prog;
};

export const updateReferralConfig = async (tenantId: string, input: any, userId: string) => {
  const Program = ReferralProgramModel(tenantId);
  const updated = await Program.findOneAndUpdate(
    {},
    { $set: input },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  await audit(tenantId, {
    action: 'referral.config_updated',
    entity: 'referral_program',
    entityId: 'global',
    meta: { by: userId },
  });
  return updated;
};

/** Generates a unique 6-character referral code for a student if not already present */
export const getOrCreateStudentReferralCode = async (tenantId: string, studentId: string) => {
  const Student = StudentModel(tenantId);
  const student = await Student.findById(studentId);
  if (!student) throw notFound('Student');

  // Generate code: First 3 letters of name + last 3 of ID
  const cleanName = (student.name || 'STU').replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X');
  const tail = studentId.slice(-3).toUpperCase();
  const code = `${cleanName}${tail}`;

  return {
    referralCode: code,
    shareUrl: `/enquiry?ref=${code}`,
    studentName: student.name,
    studentPhone: student.phone,
  };
};

/** Logs a referral when a new lead enters via a referral code */
export const recordReferralLead = async (tenantId: string, lead: { id: string; name: string; phone: string; referralCode: string }) => {
  if (!lead.referralCode) return null;
  const config = await getReferralConfig(tenantId);
  if (!config.enabled) return null;

  const code = lead.referralCode.trim().toUpperCase();

  // Find referring student by tail matching their ID
  const tail = code.slice(-3).toLowerCase();
  const Student = StudentModel(tenantId);
  const allStudents = await Student.find({ status: 'active' }).select('_id name phone').lean();
  const referrer = allStudents.find((s) => String(s._id).toLowerCase().endsWith(tail));

  if (!referrer) return null; // unknown referrer code

  const Referral = ReferralModel(tenantId);
  // Avoid duplicate referral entry for same phone
  const existing = await Referral.findOne({ referredPhone: lead.phone });
  if (existing) return existing.toObject();

  const refDoc = await Referral.create({
    referralCode: code,
    referrerStudentId: String(referrer._id),
    referrerName: referrer.name,
    referrerPhone: referrer.phone,
    referredLeadId: lead.id,
    referredName: lead.name,
    referredPhone: lead.phone,
    status: 'pending',
    rewardAmountRupees: config.rewardAmountRupees,
  });

  await audit(tenantId, {
    action: 'referral.lead_captured',
    entity: 'referral',
    entityId: String(refDoc._id),
    meta: { code, referrerId: referrer._id, referredPhone: lead.phone },
  });

  return refDoc.toObject();
};

/** Mark referral as enrolled or rewarded */
export const updateReferralStatus = async (
  tenantId: string,
  referralId: string,
  status: ReferralStatus,
  notes?: string,
) => {
  const Referral = ReferralModel(tenantId);
  const update: any = { status, rewardNotes: notes };
  if (status === 'rewarded') update.rewardedAt = new Date();

  const updated = await Referral.findByIdAndUpdate(referralId, { $set: update }, { new: true }).lean();
  if (!updated) throw notFound('Referral');

  await audit(tenantId, {
    action: `referral.status_${status}`,
    entity: 'referral',
    entityId: referralId,
    meta: { status, notes },
  });

  return updated;
};

export const listReferrals = async (tenantId: string, query: { status?: string; studentId?: string }) => {
  const q: any = {};
  if (query.status) q.status = query.status;
  if (query.studentId) q.referrerStudentId = query.studentId;
  return ReferralModel(tenantId).find(q).sort({ createdAt: -1 }).lean();
};

