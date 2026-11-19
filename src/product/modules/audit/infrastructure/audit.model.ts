import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';

/** "Who did what, when": append-only trail (in the organisation's own database) for everything that changes money or student progress. */
const auditSchema = new Schema(
  {
    actorId: String,
    action: { type: String, required: true, index: true }, // e.g. lead.stage_changed
    entity: { type: String, required: true }, // e.g. lead
    entityId: { type: String, index: true },
    meta: Schema.Types.Mixed,
    requestId: String,
    /** true when platform staff did this while acting inside the organisation (actorId is then the staff member) */
    actingAs: Boolean,
  },
  { timestamps: { createdAt: 'at', updatedAt: false } },
);
auditSchema.index({ at: -1 });

export const AuditModel = defineTenantModel('AuditLog', auditSchema);
