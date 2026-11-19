import { notFound } from '../../../../shared/kernel/errors.js';
import { recordPlatformAudit } from '../../audit/index.js';
import { getTenantRecord } from '../../organisations/index.js';
import { GST_RATE_BPS } from '../domain/billing.domain.js';
import { BillingDetails, PlatformSettings } from '../infrastructure/settings.model.js';

const clean = (o: Record<string, any> | null | undefined) => {
  if (!o) return {};
  const { _id, __v, createdAt, updatedAt, ...rest } = o;
  return rest;
};

export const getSettings = async () => {
  const s = await PlatformSettings.findById('platform').lean();
  return { gstRateBps: GST_RATE_BPS, ...clean(s) } as Record<string, any> & { gstRateBps: number };
};

/** Empty strings clear a field. `bank` is replaced as a whole when sent. */
export const updateSettings = async (patch: Record<string, any>) => {
  const $set: Record<string, any> = {};
  const $unset: Record<string, 1> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === '' || v === null) $unset[k] = 1;
    else $set[k] = v;
  }
  const update: Record<string, any> = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;
  await PlatformSettings.findOneAndUpdate({ _id: 'platform' }, update, { upsert: true, new: true, setDefaultsOnInsert: true });
  await recordPlatformAudit({ action: 'settings.updated', targetType: 'settings' as never, targetId: 'platform', meta: { fields: Object.keys(patch) } });
  return getSettings();
};

export const getBillingDetails = async (tenantId: string) => clean(await BillingDetails.findOne({ tenantId }).lean());

export const setBillingDetails = async (tenantId: string, patch: Record<string, string>) => {
  if (!(await getTenantRecord(tenantId))) throw notFound('Organisation');
  const $set: Record<string, string> = {};
  const $unset: Record<string, 1> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === '') $unset[k] = 1;
    else $set[k] = v;
  }
  const update: Record<string, any> = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;
  await BillingDetails.findOneAndUpdate({ tenantId }, update, { upsert: true, new: true });
  await recordPlatformAudit({ action: 'tenant.billing_details_changed', targetType: 'tenant', targetId: tenantId, tenantId, meta: { fields: Object.keys(patch) } });
  return getBillingDetails(tenantId);
};
