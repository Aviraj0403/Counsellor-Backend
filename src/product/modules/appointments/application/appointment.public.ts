import { env } from '../../../../config/env.js';
import { getPlatform } from '../../../../contracts/registry.js';
import { AppError, badRequest, notFound } from '../../../../shared/kernel/errors.js';
import { canCancel, isActive } from '../domain/appointment.domain.js';
import { AppointmentModel, AppointmentTypeModel } from '../infrastructure/appointment.model.js';
import { bookCore, hashToken, loadType, rescheduleCore, slotsFor, transitionCore, validateRange, type BookInput } from './appointment.core.js';

export interface PublicOrg { tenantId: string; slug: string; name: string }

/** Organisation from the address in the URL. Unknown, suspended or module-off all look the same: 404. */
export const loadPublicOrg = async (slug: string): Promise<PublicOrg | null> => {
  const platform = getPlatform();
  const t = await platform.findTenantBySlug(slug.toLowerCase());
  if (!t || t.status !== 'active') return null;
  if (!(await platform.enabledModules(t.id))['appointments']) return null;
  return { tenantId: t.id, slug: slug.toLowerCase(), name: t.name };
};

export const manageUrl = (slug: string, token: string) => `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/public/${encodeURIComponent(slug)}/appointments/manage/${token}`;

export const publicTypes = async (o: PublicOrg) => {
  const rows = await AppointmentTypeModel(o.tenantId).find({ active: true, publicBookable: true }).sort({ name: 1 }).lean<any[]>();
  return {
    organisation: o.name,
    items: rows.map((t) => ({
      id: String(t._id),
      name: t.name,
      description: t.description ?? '',
      mode: t.mode,
      durationMin: t.durationMin,
      policyText: t.policyText ?? '',
      cancellationNoticeHours: t.cancellationNoticeHours,
      intakeQuestions: t.intakeQuestions ?? [],
      locationOrLink: undefined, // shown to the booker only after booking
    })),
  };
};

/** Slots without counsellor identity; two counsellors free at the same time show as one slot. */
export const publicSlots = async (o: PublicOrg, q: { typeId: string; from: Date; to: Date }) => {
  validateRange(q.from, q.to);
  const type = await loadType(o.tenantId, q.typeId);
  if (!type.active || !type.publicBookable) throw notFound('Appointment type');
  const slots = await slotsFor(o.tenantId, type, { from: q.from, to: q.to });
  const seen = new Set<number>();
  const items = slots.filter((s) => (seen.has(s.start.getTime()) ? false : (seen.add(s.start.getTime()), true))).map((s) => ({ start: s.start, end: s.end }));
  return { items };
};

export const publicBook = async (o: PublicOrg, input: Omit<BookInput, 'source' | 'consentGiven'> & { consentGiven: boolean }) => {
  if (input.consentGiven !== true) throw new AppError(400, 'CONSENT_REQUIRED', 'Please tick the consent box so we can contact you about this appointment.');
  const { doc, token } = await bookCore(o.tenantId, { ...input, source: 'public' });
  const type = await loadType(o.tenantId, String(doc.typeId));
  return {
    id: String(doc._id),
    start: doc.start,
    end: doc.end,
    mode: type.mode,
    locationOrLink: type.locationOrLink ?? undefined,
    policyText: type.policyText ?? '',
    manageToken: token,
    manageUrl: manageUrl(o.slug, token),
  };
};

const findByToken = async (o: PublicOrg, token: string) => {
  const a = await AppointmentModel(o.tenantId).findOne({ manageTokenHash: hashToken(token) });
  if (!a) throw notFound('Appointment');
  return a;
};

const view = async (o: PublicOrg, a: any, now: Date) => {
  const type = await loadType(o.tenantId, a.typeId);
  return {
    id: String(a._id),
    typeName: type.name,
    mode: type.mode,
    start: a.start,
    end: a.end,
    status: a.status,
    name: a.who?.name,
    locationOrLink: isActive(a.status) ? (type.locationOrLink ?? undefined) : undefined,
    policyText: type.policyText ?? '',
    cancellationNoticeHours: type.cancellationNoticeHours,
    canChange: isActive(a.status) && canCancel(type, a.start, now),
  };
};

export const manageView = async (o: PublicOrg, token: string, now = new Date()) => view(o, await findByToken(o, token), now);

const assertChangeAllowed = async (o: PublicOrg, a: any, now: Date) => {
  if (!isActive(a.status)) throw badRequest(`This appointment is already ${a.status.replace('_', ' ')}.`);
  const type = await loadType(o.tenantId, a.typeId);
  if (!canCancel(type, a.start, now)) {
    throw badRequest(`Changes are allowed until ${type.cancellationNoticeHours} hour(s) before the appointment. Please call the counsellor.${type.policyText ? ` Policy: ${type.policyText}` : ''}`);
  }
};

export const manageCancel = async (o: PublicOrg, token: string, reason?: string, now = new Date()) => {
  const a = await findByToken(o, token);
  await assertChangeAllowed(o, a, now);
  await transitionCore(o.tenantId, a, 'cancelled', { cancelReason: reason || 'Cancelled by the student', cancelledBy: 'booker' });
  return view(o, a, now);
};

export const manageReschedule = async (o: PublicOrg, token: string, start: Date, now = new Date()) => {
  const a = await findByToken(o, token);
  await assertChangeAllowed(o, a, now);
  const { doc, token: newToken } = await rescheduleCore(o.tenantId, a, start, { byBooker: true, now });
  return { ...(await view(o, doc, now)), manageToken: newToken, manageUrl: manageUrl(o.slug, newToken) };
};
