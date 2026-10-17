import mongoose from 'mongoose';

const ledgerEntrySchema = new mongoose.Schema({
  transferId: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  bucket: { type: String, enum: ['available', 'offline-reserve'], required: true },
  direction: { type: String, enum: ['debit', 'credit'], required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  balanceAfterPaise: { type: Number, required: true, min: 0 },
  createdAt: { type: Date, default: Date.now, immutable: true },
}, { versionKey: false });

ledgerEntrySchema.index({ transferId: 1, user: 1, bucket: 1, direction: 1 }, { unique: true });
ledgerEntrySchema.index({ user: 1, createdAt: -1 });
export const LedgerEntry = mongoose.model('LedgerEntry', ledgerEntrySchema);
