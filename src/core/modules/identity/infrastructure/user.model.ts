import mongoose, { Schema, model, type Model } from 'mongoose';

export interface UserDoc {
  _id: any;
  email: string;
  name: string;
  passwordHash: string;
  role: string;
  /** null for platform staff */
  tenantId: string | null;
  status: 'active' | 'blocked';
  /** bumped on password change / "log out everywhere": every older token stops working immediately */
  tokenVersion: number;
  /** portal users only: the student id / college id this login is tied to (they only ever see that slice) */
  linkedId?: string | null;
  lastLoginAt?: Date;
  /** TOTP: secret is AES-GCM encrypted; recovery codes are SHA-256 hashes, removed once used */
  mfaEnabled?: boolean;
  mfaSecretEnc?: string | null;
  mfaPendingSecretEnc?: string | null;
  mfaRecoveryHashes?: string[];
  mfaLastStep?: number;
  mfaFailCount?: number;
  mfaLockedUntil?: Date | null;
}

const userSchema = new Schema<UserDoc>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, required: true },
    tenantId: { type: String, default: null, index: true },
    status: { type: String, enum: ['active', 'blocked'], default: 'active' },
    tokenVersion: { type: Number, default: 0 },
    linkedId: { type: String, default: null, index: true },
    lastLoginAt: Date,
    mfaEnabled: { type: Boolean, default: false },
    mfaSecretEnc: { type: String, default: null, select: false },
    mfaPendingSecretEnc: { type: String, default: null, select: false },
    mfaRecoveryHashes: { type: [String], default: [], select: false },
    mfaLastStep: { type: Number, default: 0 },
    mfaFailCount: { type: Number, default: 0 },
    mfaLockedUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

export const User: Model<UserDoc> = (mongoose.models.User as Model<UserDoc>) || model<UserDoc>('User', userSchema);
