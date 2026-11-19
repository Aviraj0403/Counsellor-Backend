import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';

const documentSchema = new Schema(
  {
    studentId: { type: String, required: true },
    applicationId: String,
    type: { type: String, required: true },
    label: String,
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    sha256: { type: String, required: true },
    storageKey: { type: String, required: true },
    status: { type: String, enum: ['pending_review', 'verified', 'rejected'], default: 'pending_review' },
    rejectReason: String,
    verifiedBy: String,
    verifiedAt: Date,
    uploadedBy: { type: String, required: true },
    version: { type: Number, default: 1 },
    supersededBy: String,
    deletedAt: Date,
  },
  { timestamps: true },
);
documentSchema.index({ studentId: 1, type: 1, createdAt: 1 });
documentSchema.index({ applicationId: 1 });
documentSchema.index({ status: 1, createdAt: 1 });

export const DocumentModel = defineTenantModel('Document', documentSchema);
