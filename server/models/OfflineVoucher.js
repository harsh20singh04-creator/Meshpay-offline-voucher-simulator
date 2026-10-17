import mongoose from 'mongoose';

const offlineVoucherSchema = new mongoose.Schema({
  voucherId: { type: String, required: true, unique: true },
  deviceId: { type: String, required: true },
  sequence: { type: Number, required: true, min: 1 },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  payloadHash: { type: String, required: true },
  signature: { type: String, required: true },
  status: { type: String, enum: ['settled', 'rejected'], required: true },
  rejectionCode: { type: String, default: null },
  transferId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, immutable: true },
}, { versionKey: false });

offlineVoucherSchema.index({ deviceId: 1, sequence: 1 }, { unique: true });
offlineVoucherSchema.index({ receiver: 1, createdAt: -1 });
export const OfflineVoucher = mongoose.model('OfflineVoucher', offlineVoucherSchema);
