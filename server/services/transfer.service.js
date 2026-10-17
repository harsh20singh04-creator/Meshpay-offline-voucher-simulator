import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { Transfer } from '../models/Transfer.js';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { AppError, conflict, notFound } from '../utils/AppError.js';
import { sha256 } from '../utils/crypto.js';

function amountGuard(amountPaise) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 1 || amountPaise > env.MAX_TRANSFER_PAISE) {
    throw new AppError(400, 'INVALID_AMOUNT', `Amount must be between ₹0.01 and ₹${(env.MAX_TRANSFER_PAISE / 100).toFixed(2)}.`);
  }
}

function requestDigest({ receiverId, amountPaise, note = '' }) {
  return sha256(JSON.stringify({ receiverId: receiverId.toString(), amountPaise, note }));
}

async function findIdempotentResult(senderId, key, digest) {
  const prior = await Transfer.findOne({ sender: senderId, idempotencyKey: key });
  if (!prior) return null;
  if (prior.requestHash !== digest) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with a different request.');
  return prior;
}

export async function createOnlineTransfer({ senderId, receiverHandle, amountPaise, note = '', idempotencyKey }) {
  amountGuard(amountPaise);
  const senderObjectId = new mongoose.Types.ObjectId(senderId);
  const receiver = await User.findOne({ handle: receiverHandle.toLowerCase() });
  if (!receiver) throw notFound('Recipient handle was not found.');
  if (receiver._id.equals(senderObjectId)) throw new AppError(400, 'SELF_TRANSFER', 'You cannot send money to yourself.');
  const digest = requestDigest({ receiverId: receiver._id, amountPaise, note });
  const scopedKey = `online:${idempotencyKey}`;

  const existing = await findIdempotentResult(senderObjectId, scopedKey, digest);
  if (existing) return { transfer: existing, replayed: true };

  const session = await mongoose.startSession();
  let result;
  let replayed = false;
  try {
    await session.withTransaction(async () => {
      const prior = await Transfer.findOne({ sender: senderObjectId, idempotencyKey: scopedKey }).session(session);
      if (prior) {
        if (prior.requestHash !== digest) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with a different request.');
        result = prior;
        replayed = true;
        return;
      }

      const debited = await User.findOneAndUpdate(
        { _id: senderObjectId, balancePaise: { $gte: amountPaise } },
        { $inc: { balancePaise: -amountPaise } },
        { new: true, session },
      );
      if (!debited) throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Available balance is too low for this payment.');
      const credited = await User.findByIdAndUpdate(receiver._id, { $inc: { balancePaise: amountPaise } }, { new: true, session });
      if (!credited) throw notFound('Recipient account no longer exists.');

      const transferId = randomUUID();
      const [transfer] = await Transfer.create([{
        transferId, idempotencyKey: scopedKey, requestHash: digest,
        sender: senderObjectId, receiver: receiver._id, amountPaise,
        kind: 'online', status: 'completed', note,
      }], { session, ordered: true });
      await LedgerEntry.create([
        { transferId, user: senderObjectId, bucket: 'available', direction: 'debit', amountPaise, balanceAfterPaise: debited.balancePaise },
        { transferId, user: receiver._id, bucket: 'available', direction: 'credit', amountPaise, balanceAfterPaise: credited.balancePaise },
      ], { session, ordered: true });
      result = transfer;
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    return { transfer: result, replayed };
  } catch (error) {
    if (error?.code === 11000) {
      const recovered = await findIdempotentResult(senderObjectId, scopedKey, digest);
      if (recovered) return { transfer: recovered, replayed: true };
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function reserveOfflineFunds({ userId, amountPaise, idempotencyKey }) {
  amountGuard(amountPaise);
  const senderObjectId = new mongoose.Types.ObjectId(userId);
  const digest = sha256(JSON.stringify({ amountPaise, purpose: 'offline-reserve' }));
  const scopedKey = `reserve:${idempotencyKey}`;
  const existing = await findIdempotentResult(senderObjectId, scopedKey, digest);
  if (existing) return { transfer: existing, replayed: true };

  const session = await mongoose.startSession();
  let result;
  let replayed = false;
  try {
    await session.withTransaction(async () => {
      const prior = await Transfer.findOne({ sender: senderObjectId, idempotencyKey: scopedKey }).session(session);
      if (prior) {
        if (prior.requestHash !== digest) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with a different request.');
        result = prior;
        replayed = true;
        return;
      }
      const moved = await User.findOneAndUpdate(
        { _id: senderObjectId, balancePaise: { $gte: amountPaise } },
        { $inc: { balancePaise: -amountPaise, offlineReservedPaise: amountPaise } },
        { new: true, session },
      );
      if (!moved) throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Available balance is too low to reserve this amount.');
      const transferId = randomUUID();
      const [transfer] = await Transfer.create([{
        transferId, idempotencyKey: scopedKey, requestHash: digest,
        sender: senderObjectId, receiver: senderObjectId, amountPaise,
        kind: 'reserve', status: 'completed', note: 'Move funds to offline reserve',
      }], { session, ordered: true });
      await LedgerEntry.create([
        { transferId, user: senderObjectId, bucket: 'available', direction: 'debit', amountPaise, balanceAfterPaise: moved.balancePaise },
        { transferId, user: senderObjectId, bucket: 'offline-reserve', direction: 'credit', amountPaise, balanceAfterPaise: moved.offlineReservedPaise },
      ], { session, ordered: true });
      result = transfer;
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    return { transfer: result, replayed };
  } catch (error) {
    if (error?.code === 11000) {
      const recovered = await findIdempotentResult(senderObjectId, scopedKey, digest);
      if (recovered) return { transfer: recovered, replayed: true };
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

export function transferDto(transfer, currentUserId) {
  return {
    transferId: transfer.transferId,
    amountPaise: transfer.amountPaise,
    kind: transfer.kind,
    status: transfer.status,
    note: transfer.note,
    direction: transfer.sender.toString() === currentUserId.toString() ? 'sent' : transfer.receiver.toString() === currentUserId.toString() ? 'received' : 'self',
    createdAt: transfer.createdAt,
  };
}

export async function releaseOfflineReserve({ userId, idempotencyKey }) {
  const senderObjectId = new mongoose.Types.ObjectId(userId);
  const digest = sha256(JSON.stringify({ purpose: 'release-offline-reserve' }));
  const scopedKey = `release:${idempotencyKey}`;
  const existing = await findIdempotentResult(senderObjectId, scopedKey, digest);
  if (existing) return { transfer: existing, replayed: true };

  const session = await mongoose.startSession();
  let result;
  let replayed = false;
  try {
    await session.withTransaction(async () => {
      const prior = await Transfer.findOne({ sender: senderObjectId, idempotencyKey: scopedKey }).session(session);
      if (prior) {
        if (prior.requestHash !== digest) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with a different request.');
        result = prior;
        replayed = true;
        return;
      }
      const current = await User.findById(senderObjectId).session(session);
      if (!current) throw notFound('Account no longer exists.');
      const amountPaise = current.offlineReservedPaise;
      if (amountPaise <= 0) throw conflict('NO_OFFLINE_RESERVE', 'There are no funds in the offline reserve to release.');
      const updated = await User.findOneAndUpdate(
        { _id: senderObjectId, offlineReservedPaise: { $gte: amountPaise } },
        { $inc: { balancePaise: amountPaise, offlineReservedPaise: -amountPaise, offlineEpoch: 1 } },
        { new: true, session },
      );
      if (!updated) throw new AppError(409, 'RESERVE_CHANGED', 'Offline reserve changed concurrently. Retry safely using the same key.');
      const transferId = randomUUID();
      const [transfer] = await Transfer.create([{
        transferId, idempotencyKey: scopedKey, requestHash: digest,
        sender: senderObjectId, receiver: senderObjectId, amountPaise,
        kind: 'release', status: 'completed', note: 'Return unused offline reserve; prior vouchers revoked',
      }], { session, ordered: true });
      await LedgerEntry.create([
        { transferId, user: senderObjectId, bucket: 'offline-reserve', direction: 'debit', amountPaise, balanceAfterPaise: updated.offlineReservedPaise },
        { transferId, user: senderObjectId, bucket: 'available', direction: 'credit', amountPaise, balanceAfterPaise: updated.balancePaise },
      ], { session, ordered: true });
      result = transfer;
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    return { transfer: result, replayed };
  } catch (error) {
    if (error?.code === 11000) {
      const recovered = await findIdempotentResult(senderObjectId, scopedKey, digest);
      if (recovered) return { transfer: recovered, replayed: true };
    }
    throw error;
  } finally {
    await session.endSession();
  }
}
