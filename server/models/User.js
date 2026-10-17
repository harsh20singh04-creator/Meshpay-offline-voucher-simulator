import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  displayName: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
  handle: { type: String, required: true, unique: true, lowercase: true, trim: true, minlength: 3, maxlength: 24, match: /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/ },
  passwordHash: { type: String, required: true, select: false },
  balancePaise: { type: Number, required: true, min: 0, default: 0 },
  offlineReservedPaise: { type: Number, required: true, min: 0, default: 0 },
  offlineEpoch: { type: Number, required: true, min: 0, default: 0 },
}, { timestamps: true, versionKey: false });

userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    displayName: this.displayName,
    handle: this.handle,
    balancePaise: this.balancePaise,
    offlineReservedPaise: this.offlineReservedPaise,
    offlineEpoch: this.offlineEpoch,
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model('User', userSchema);
