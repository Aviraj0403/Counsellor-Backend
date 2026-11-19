import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';

const lineSchema = new Schema(
  { account: { type: String, required: true }, debit: { type: Number, required: true }, credit: { type: Number, required: true } },
  { _id: false },
);

const entrySchema = new Schema(
  {
    idempotencyKey: { type: String, required: true }, // posting the same key twice returns the first entry, never a duplicate
    reference: { type: String, required: true, maxlength: 120 }, // e.g. "FEE-2026-0042" or a receipt number
    description: { type: String, maxlength: 300 },
    lines: { type: [lineSchema], required: true },
    totalPaise: { type: Number, required: true },
    reversalOf: String,
    postedBy: String,
  },
  { timestamps: { createdAt: 'postedAt', updatedAt: false } },
);
entrySchema.index({ idempotencyKey: 1 }, { unique: true });
entrySchema.index({ reversalOf: 1 }, { unique: true, sparse: true }); // an entry can be reversed only once
entrySchema.index({ 'lines.account': 1, postedAt: -1 });

// IMMUTABLE: any attempt to edit or delete an entry fails. Corrections are new (reversal) entries.
const block = () => {
  throw new Error('Ledger entries are immutable. Post a reversal entry instead.');
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  entrySchema.pre(op as any, block);
}
entrySchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error('Ledger entries are immutable. Post a reversal entry instead.'));
  next();
});

export const LedgerEntryModel = defineTenantModel('LedgerEntry', entrySchema);
