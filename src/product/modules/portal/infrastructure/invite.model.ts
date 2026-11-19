import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';

/** A portal login we created for a student or a college employee. The password is never stored here. */
const inviteSchema = new Schema(
  {
    kind: { type: String, enum: ['student', 'college'], required: true },
    linkedId: { type: String, required: true }, // studentId or collegeId
    userId: { type: String, required: true },
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    createdBy: String,
    disabledAt: Date,
    disabledBy: String,
  },
  { timestamps: true },
);
// One active invite per email, and one active invite per student.
inviteSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
inviteSchema.index({ linkedId: 1 }, { unique: true, partialFilterExpression: { status: 'active', kind: 'student' } });
inviteSchema.index({ userId: 1 });
inviteSchema.index({ kind: 1, createdAt: -1 });

export const InviteModel = defineTenantModel('PortalInvite', inviteSchema);
