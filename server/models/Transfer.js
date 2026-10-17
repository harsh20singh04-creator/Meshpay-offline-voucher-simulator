import mongoose from 'mongoose';

const transferSchema = new mongoose.Schema({
  transferId: { type: String, required: true, unique: true },
  idempotencyKey: { type: String, required: true },
  requestHash: { type: String, required: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amountPaise: { type: Number, required: true, min: 1 },
  kind: { type: String, enum: ['online', 'offline', 'reserve', 'release'], required: true },
  status: { type: String, enum: ['completed'], required: true, default: 'completed' },
  note: { type: String, maxlength: 120, default: '' },
  createdAt: { type: Date, default: Date.now, immutable: true },
}, { versionKey: false });

transferSchema.index({ sender: 1, idempotencyKey: 1 }, { unique: true });
transferSchema.index({ sender: 1, createdAt: -1 });
transferSchema.index({ receiver: 1, createdAt: -1 });
export const Transfer = mongoose.model('Transfer', transferSchema);
