import mongoose from 'mongoose';

const deviceKeySchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  publicKeySpki: { type: String, required: true },
  encryptionPublicKeySpki: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, immutable: true },
  lastSeenAt: { type: Date, default: Date.now },
}, { versionKey: false });

deviceKeySchema.index({ user: 1, deviceId: 1 }, { unique: true });
export const DeviceKey = mongoose.model('DeviceKey', deviceKeySchema);
