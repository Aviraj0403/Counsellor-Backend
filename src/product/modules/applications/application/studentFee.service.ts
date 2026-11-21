import { env } from '../../../../config/env.js';
import type { Principal } from '../../../../contracts/port.js';
import { httpRequest } from '../../../../shared/infra/http.js';
import { logger } from '../../../../shared/infra/logger.js';
import { notFound, badRequest, conflict } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import { StudentModel } from '../../students/infrastructure/student.model.js';
import { ApplicationModel } from '../infrastructure/application.model.js';
import { StudentFeeLinkModel, type FeePaymentStatus } from '../infrastructure/feeLink.model.js';

const RAZORPAY_API = 'https://api.razorpay.com/v1';

export interface CreateStudentFeeLinkInput {
  studentId: string;
  applicationId?: string;
  title: string;
  amountRupees: number;
  notes?: string;
}

export const listStudentFeeLinks = async (tenantId: string, filter: { studentId?: string; applicationId?: string }) => {
  const q: any = {};
  if (filter.studentId) q.studentId = filter.studentId;
  if (filter.applicationId) q.applicationId = filter.applicationId;
  return StudentFeeLinkModel(tenantId).find(q).sort({ createdAt: -1 }).lean();
};

export const createStudentFeeLink = async (p: Principal, input: CreateStudentFeeLinkInput) => {
  const tenantId = p.tenantId!;
  const student = await StudentModel(tenantId).findById(input.studentId).lean<any>();
  if (!student) throw notFound('Student');

  if (input.applicationId) {
    const app = await ApplicationModel(tenantId).findById(input.applicationId).lean();
    if (!app) throw notFound('Application');
  }

  const amountPaise = Math.round(input.amountRupees * 100);
  if (amountPaise < 100) throw badRequest('Minimum payment amount is ₹1.');

  let razorpayLinkId: string | undefined;
  let shortUrl: string | undefined;

  // Generate live Razorpay link if keys configured
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    try {
      const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
      const res = await httpRequest(`${RAZORPAY_API}/payment_links`, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}` },
        body: {
          amount: amountPaise,
          currency: 'INR',
          description: input.title,
          customer: {
            name: student.name,
            contact: student.phone,
            email: student.email || undefined,
          },
          notify: { sms: true, email: !!student.email },
          notes: {
            tenantId,
            studentId: input.studentId,
            applicationId: input.applicationId || '',
          },
        },
      });

      const d = res.data as { id?: string; short_url?: string } | null;
      if (res.ok && d?.id && d.short_url) {
        razorpayLinkId = d.id;
        shortUrl = d.short_url;
      }
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'razorpay student payment link call failed, falling back to simulated link');
    }
  }

  // Fallback simulated URL if razorpay keys are unset or in test mode
  if (!shortUrl) {
    shortUrl = `https://rzp.io/i/sim_${Date.now().toString(36)}`;
    razorpayLinkId = `plink_sim_${Date.now()}`;
  }

  const doc = await StudentFeeLinkModel(tenantId).create({
    studentId: input.studentId,
    applicationId: input.applicationId,
    title: input.title,
    amountPaise,
    currency: 'INR',
    status: 'created',
    razorpayLinkId,
    shortUrl,
    notes: input.notes,
    createdBy: p.userId,
  });

  await audit(tenantId, {
    action: 'fee_link.created',
    entity: 'student_fee_link',
    entityId: String(doc._id),
    meta: { studentId: input.studentId, amountRupees: input.amountRupees, shortUrl },
  });

  return doc.toObject();
};

/** Mark a student fee link as paid (e.g. from Razorpay webhook or manual bank verification) */
export const markStudentFeePaid = async (
  tenantId: string,
  linkId: string,
  paymentDetails: { paymentId?: string; notes?: string },
  userId: string,
) => {
  const FeeLink = StudentFeeLinkModel(tenantId);
  const link = await FeeLink.findById(linkId);
  if (!link) throw notFound('FeeLink');
  if (link.status === 'paid') return link.toObject();

  link.status = 'paid';
  link.paymentId = paymentDetails.paymentId || `manual_${Date.now()}`;
  link.paidAt = new Date();
  if (paymentDetails.notes) link.notes = `${link.notes ? link.notes + ' - ' : ''}${paymentDetails.notes}`;
  await link.save();

  // If tied to an application, increment its paid fee
  if (link.applicationId) {
    await ApplicationModel(tenantId).updateOne(
      { _id: link.applicationId },
      { $inc: { 'fee.paidPaise': link.amountPaise } },
    );
  }

  await audit(tenantId, {
    action: 'fee_link.paid',
    entity: 'student_fee_link',
    entityId: linkId,
    meta: { amountPaise: link.amountPaise, paymentId: link.paymentId, by: userId },
  });

  return link.toObject();
};

