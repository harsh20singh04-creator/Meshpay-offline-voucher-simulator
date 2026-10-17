
import mongoose from 'mongoose';
import { createPublicKey as createPublicKeyNode, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { DeviceKey } from '../models/DeviceKey.js';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { OfflineVoucher } from '../models/OfflineVoucher.js';
import { Transfer } from '../models/Transfer.js';
import { User } from '../models/User.js';
import { AppError, conflict, notFound } from '../utils/AppError.js';
import {
  canonicalJson,
  sha256,
  verifyEd25519Signature,
} from '../utils/crypto.js';

const handlePattern = /^[a-z0-9][a-z0-9._-]{1,22}[a-z0-9]$/;

const payloadSchema = z.object({
  voucherId: z.string().uuid(),
  deviceId: z.string().uuid(),
  sequence: z.number().int().positive().safe(),
  senderId: z.string().regex(/^[a-f\d]{24}$/i),
  offlineEpoch: z.number().int().nonnegative().safe(),
  receiverHandle: z.string().regex(handlePattern).max(24),
  amountPaise: z.number().int().positive().safe(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  memo: z.string().max(100),
}).strict();

function assertPublicKey(publicKeySpki) {
  if (
    typeof publicKeySpki !== 'string' ||
    publicKeySpki.length > 512 ||
    !/^[A-Za-z0-9+/]+=*$/.test(publicKeySpki)
  ) {
    throw new AppError(
      400,
      'INVALID_PUBLIC_KEY',
      'Public key must be a base64-encoded Ed25519 SPKI key.',
    );
  }

  try {
    const key = createPublicKeyNode({
      key: Buffer.from(publicKeySpki, 'base64'),
      format: 'der',
      type: 'spki',
    });

    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error('Wrong key type');
    }
  } catch {
    throw new AppError(
      400,
      'INVALID_PUBLIC_KEY',
      'Public key is not a valid Ed25519 SPKI key.',
    );
  }
}

function assertEncryptionPublicKey(publicKeySpki) {
  if (
    typeof publicKeySpki !== 'string' ||
    publicKeySpki.length > 1024 ||
    !/^[A-Za-z0-9+/]+=*$/.test(publicKeySpki)
  ) {
    throw new AppError(
      400,
      'INVALID_ENCRYPTION_KEY',
      'Encryption key must be a base64-encoded RSA SPKI public key.',
    );
  }

  try {
    const key = createPublicKeyNode({
      key: Buffer.from(publicKeySpki, 'base64'),
      format: 'der',
      type: 'spki',
    });

    if (
      key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new Error('RSA key must be at least 2048 bits');
    }
  } catch {
    throw new AppError(
      400,
      'INVALID_ENCRYPTION_KEY',
      'Encryption key must be an RSA public key with at least 2048-bit modulus.',
    );
  }
}

export async function registerDeviceKey({
  userId,
  deviceId,
  publicKeySpki,
  encryptionPublicKeySpki,
}) {
  z.string().uuid().parse(deviceId);
  assertPublicKey(publicKeySpki);
  assertEncryptionPublicKey(encryptionPublicKeySpki);

  const existing = await DeviceKey.findOne({ deviceId });

  if (existing) {
    if (
      existing.user.toString() !== userId ||
      existing.publicKeySpki !== publicKeySpki ||
      (
        existing.encryptionPublicKeySpki &&
        existing.encryptionPublicKeySpki !== encryptionPublicKeySpki
      )
    ) {
      throw conflict(
        'DEVICE_ID_CONFLICT',
        'This device ID is already registered to a different key or account.',
      );
    }

    existing.encryptionPublicKeySpki = encryptionPublicKeySpki;
    existing.lastSeenAt = new Date();
    await existing.save();

    return existing;
  }

  try {
    return await DeviceKey.create({
      deviceId,
      user: userId,
      publicKeySpki,
      encryptionPublicKeySpki,
      lastSeenAt: new Date(),
    });
  } catch (error) {
    if (error?.code === 11000) {
      const raced = await DeviceKey.findOne({ deviceId });

      if (
        raced &&
        raced.user.toString() === userId &&
        raced.publicKeySpki === publicKeySpki &&
        raced.encryptionPublicKeySpki === encryptionPublicKeySpki
      ) {
        return raced;
      }

      throw conflict(
        'DEVICE_ID_CONFLICT',
        'This device ID is already registered.',
      );
    }

    throw error;
  }
}

function voucherDto(voucher, duplicate = false) {
  return {
    voucherId: voucher.voucherId,
    amountPaise: voucher.amountPaise,
    status: voucher.status,
    rejectionCode: voucher.rejectionCode,
    transferId: voucher.transferId,
    duplicate,
    createdAt: voucher.createdAt,
  };
}

export async function syncOfflineVoucher({ receiverUserId, packet }) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    throw new AppError(
      400,
      'INVALID_VOUCHER',
      'Voucher must be a JSON object.',
    );
  }

  const payload = payloadSchema.parse(packet.payload);

  if (
    typeof packet.signature !== 'string' ||
    packet.signature.length > 256 ||
    !/^[A-Za-z0-9+/]+=*$/.test(packet.signature)
  ) {
    throw new AppError(
      400,
      'INVALID_SIGNATURE',
      'Voucher signature is missing or malformed.',
    );
  }

  if (payload.amountPaise > env.MAX_TRANSFER_PAISE) {
    throw new AppError(
      400,
      'INVALID_AMOUNT',
      'Voucher amount exceeds the configured limit.',
    );
  }

  const canonicalPayload = canonicalJson(payload);
  const digest = sha256(canonicalPayload);

  const existingVoucher = await OfflineVoucher.findOne({
    voucherId: payload.voucherId,
  });

  if (existingVoucher) {
    if (
      existingVoucher.payloadHash !== digest ||
      existingVoucher.signature !== packet.signature
    ) {
      throw conflict(
        'VOUCHER_ID_REUSED',
        'This voucher ID was seen before with different signed contents.',
      );
    }

    if (existingVoucher.receiver.toString() !== receiverUserId) {
      throw conflict(
        'VOUCHER_ALREADY_CLAIMED',
        'This voucher has already been submitted by a different receiving account.',
      );
    }

    return voucherDto(existingVoucher, true);
  }

  const device = await DeviceKey.findOne({
    deviceId: payload.deviceId,
  });

  if (!device || device.user.toString() !== payload.senderId) {
    throw new AppError(
      400,
      'UNKNOWN_DEVICE',
      'The voucher device is not registered to its claimed sender.',
    );
  }

  if (packet.publicKeySpki !== device.publicKeySpki) {
    throw new AppError(
      400,
      'PUBLIC_KEY_MISMATCH',
      'Voucher public key does not match the sender device registration.',
    );
  }

  if (
    !verifyEd25519Signature(
      device.publicKeySpki,
      canonicalPayload,
      packet.signature,
    )
  ) {
    throw new AppError(
      400,
      'INVALID_SIGNATURE',
      'Voucher signature verification failed.',
    );
  }

  const receiver = await User.findOne({
    handle: payload.receiverHandle.toLowerCase(),
  });

  if (!receiver) {
    throw notFound('The receiving handle is not registered yet.');
  }

  if (receiver._id.toString() !== receiverUserId) {
    throw new AppError(
      403,
      'WRONG_RECIPIENT',
      'Only the account named in the signed voucher can submit it for settlement.',
    );
  }

  if (payload.senderId === receiverUserId) {
    throw new AppError(
      400,
      'SELF_TRANSFER',
      'Offline self-payments are not supported.',
    );
  }

  const now = Date.now();
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  const maxAge = env.OFFLINE_VOUCHER_TTL_HOURS * 60 * 60 * 1000;

  if (
    issuedAt > now + 5 * 60 * 1000 ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > maxAge ||
    now - issuedAt > maxAge
  ) {
    throw new AppError(
      400,
      'VOUCHER_EXPIRED',
      'Voucher is expired or its validity window is invalid.',
    );
  }

  const session = await mongoose.startSession();
  let finalVoucher;
  let wasDuplicate = false;

  try {
    await session.withTransaction(async () => {
      const priorById = await OfflineVoucher.findOne({
        voucherId: payload.voucherId,
      }).session(session);

      if (priorById) {
        if (
          priorById.payloadHash !== digest ||
          priorById.signature !== packet.signature
        ) {
          throw conflict(
            'VOUCHER_ID_REUSED',
            'This voucher ID was seen before with different signed contents.',
          );
        }

        if (priorById.receiver.toString() !== receiverUserId) {
          throw conflict(
            'VOUCHER_ALREADY_CLAIMED',
            'This voucher has already been submitted by a different receiving account.',
          );
        }

        // A concurrent request already created this voucher.
        wasDuplicate = true;
        finalVoucher = priorById;
        return;
      }

      const priorBySequence = await OfflineVoucher.findOne({
        deviceId: payload.deviceId,
        sequence: payload.sequence,
      }).session(session);

      if (priorBySequence) {
        throw conflict(
          'REPLAY_SEQUENCE',
          'This device sequence has already been used by another voucher.',
        );
      }

      const senderId = new mongoose.Types.ObjectId(payload.senderId);
      const sender = await User.findById(senderId).session(session);

      if (!sender) {
        throw notFound('Sender account no longer exists.');
      }

      if (payload.offlineEpoch !== sender.offlineEpoch) {
        const [rejected] = await OfflineVoucher.create([{
          voucherId: payload.voucherId,
          deviceId: payload.deviceId,
          sequence: payload.sequence,
          sender: senderId,
          receiver: receiver._id,
          amountPaise: payload.amountPaise,
          payloadHash: digest,
          signature: packet.signature,
          status: 'rejected',
          rejectionCode: 'OFFLINE_EPOCH_REVOKED',
        }], { session });

        finalVoucher = rejected;
        return;
      }

      if (sender.offlineReservedPaise < payload.amountPaise) {
        const [rejected] = await OfflineVoucher.create([{
          voucherId: payload.voucherId,
          deviceId: payload.deviceId,
          sequence: payload.sequence,
          sender: senderId,
          receiver: receiver._id,
          amountPaise: payload.amountPaise,
          payloadHash: digest,
          signature: packet.signature,
          status: 'rejected',
          rejectionCode: 'INSUFFICIENT_OFFLINE_RESERVE',
        }], { session });

        finalVoucher = rejected;
        return;
      }

      const senderAfter = await User.findOneAndUpdate(
        {
          _id: senderId,
          offlineReservedPaise: { $gte: payload.amountPaise },
        },
        { $inc: { offlineReservedPaise: -payload.amountPaise } },
        { new: true, session },
      );

      if (!senderAfter) {
        const [rejected] = await OfflineVoucher.create([{
          voucherId: payload.voucherId,
          deviceId: payload.deviceId,
          sequence: payload.sequence,
          sender: senderId,
          receiver: receiver._id,
          amountPaise: payload.amountPaise,
          payloadHash: digest,
          signature: packet.signature,
          status: 'rejected',
          rejectionCode: 'INSUFFICIENT_OFFLINE_RESERVE',
        }], { session });

        finalVoucher = rejected;
        return;
      }

      const receiverAfter = await User.findByIdAndUpdate(
        receiver._id,
        { $inc: { balancePaise: payload.amountPaise } },
        { new: true, session },
      );

      if (!receiverAfter) {
        throw notFound('Receiving account no longer exists.');
      }

      const transferId = randomUUID();

      await Transfer.create([{
        transferId,
        idempotencyKey: `offline:${payload.voucherId}`,
        requestHash: digest,
        sender: senderId,
        receiver: receiver._id,
        amountPaise: payload.amountPaise,
        kind: 'offline',
        status: 'completed',
        note: payload.memo,
      }], { session });

      await LedgerEntry.create([
        {
          transferId,
          user: senderId,
          bucket: 'offline-reserve',
          direction: 'debit',
          amountPaise: payload.amountPaise,
          balanceAfterPaise: senderAfter.offlineReservedPaise,
        },
        {
          transferId,
          user: receiver._id,
          bucket: 'available',
          direction: 'credit',
          amountPaise: payload.amountPaise,
          balanceAfterPaise: receiverAfter.balancePaise,
        },
      ], { session, ordered: true });

      const [settled] = await OfflineVoucher.create([{
        voucherId: payload.voucherId,
        deviceId: payload.deviceId,
        sequence: payload.sequence,
        sender: senderId,
        receiver: receiver._id,
        amountPaise: payload.amountPaise,
        payloadHash: digest,
        signature: packet.signature,
        status: 'settled',
        transferId,
      }], { session });

      finalVoucher = settled;
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    });

    return voucherDto(finalVoucher, wasDuplicate);
  } catch (error) {
    if (error?.code === 11000) {
      const byId = await OfflineVoucher.findOne({
        voucherId: payload.voucherId,
      });

      if (
        byId &&
        byId.payloadHash === digest &&
        byId.signature === packet.signature &&
        byId.receiver.toString() === receiverUserId
      ) {
        return voucherDto(byId, true);
      }

      const bySequence = await OfflineVoucher.findOne({
        deviceId: payload.deviceId,
        sequence: payload.sequence,
      });

      if (bySequence) {
        throw conflict(
          'REPLAY_SEQUENCE',
          'This device sequence has already been used by another voucher.',
        );
      }
    }

    throw error;
  } finally {
    await session.endSession();
  }
}
