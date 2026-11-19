import { Schema, model, models, type Model } from 'mongoose';

export interface RefreshTokenDoc {
  _id: any;
  userId: string;
  familyId: string;
  /** SHA-256 of the opaque token; the token itself is never stored */
  hash: string;
  expiresAt: Date;
  usedAt?: Date | null;
  revokedAt?: Date | null;
  userAgent?: string;
  ip?: string;
}

const schema = new Schema<RefreshTokenDoc>(
  {
    userId: { type: String, required: true, index: true },
    familyId: { type: String, required: true, index: true },
    hash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    userAgent: { type: String, maxlength: 300 },
    ip: { type: String, maxlength: 64 },
  },
  { timestamps: true },
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // Mongo removes expired rows by itself

export const RefreshToken: Model<RefreshTokenDoc> = (models.RefreshToken as Model<RefreshTokenDoc>) || model<RefreshTokenDoc>('RefreshToken', schema);
