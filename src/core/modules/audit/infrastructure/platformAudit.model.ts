import { Schema, model, models, type Model } from 'mongoose';

/** Platform-level audit (master DB): who created / changed / suspended organisations, modules, plans, invoices, staff. Append-only. */
export interface PlatformAuditDoc {
  actorId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  tenantId?: string;
  meta?: Record<string, unknown>;
  requestId?: string;
  at: Date;
}

const platformAuditSchema = new Schema<PlatformAuditDoc>(
  {
    actorId: String,
    action: { type: String, required: true, index: true },
    targetType: { type: String, required: true },
    targetId: String,
    tenantId: { type: String, index: true },
    meta: Schema.Types.Mixed,
    requestId: String,
  },
  { timestamps: { createdAt: 'at', updatedAt: false } },
);
platformAuditSchema.index({ at: -1 });

export const PlatformAudit: Model<PlatformAuditDoc> =
  (models.PlatformAudit as Model<PlatformAuditDoc>) || model<PlatformAuditDoc>('PlatformAudit', platformAuditSchema);
