import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { DeviceKey } from '../models/DeviceKey.js';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { OfflineVoucher } from '../models/OfflineVoucher.js';
import { Transfer } from '../models/Transfer.js';
import { User } from '../models/User.js';
import { registerDeviceKey, syncOfflineVoucher } from '../services/offline.service.js';
import { createOnlineTransfer, reserveOfflineFunds, releaseOfflineReserve } from '../services/transfer.service.js';
import { AppError } from '../utils/AppError.js';

const router = Router();
const handleSchema = z.string().trim().toLowerCase().min(3).max(24).regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/);
const transferSchema = z.object({ receiverHandle: handleSchema, amountPaise: z.number().int().positive(), note: z.string().trim().max(120).default('') }).strict();
const reserveSchema = z.object({ amountPaise: z.number().int().positive() }).strict();
const deviceSchema = z.object({ deviceId: z.string().uuid(), publicKeySpki: z.string().min(20).max(512), encryptionPublicKeySpki: z.string().min(20).max(1024) }).strict();
const voucherSchema = z.object({ payload: z.unknown(), signature: z.string().max(256), publicKeySpki: z.string().min(20).max(512) }).strict();

function requireIdempotencyKey(req) {
  const key = req.get('Idempotency-Key');
  if (!key || key.length < 8 || key.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-100 safe characters).');
  }
  return key;
}

router.get('/health/live', (req, res) => res.json({ status: 'ok', service: 'upi-offline' }));
router.get('/health/ready', async (req, res) => {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return res.status(503).json({ status: 'not-ready', reason: 'database-disconnected' });
  }
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') {
      return res.status(503).json({ status: 'not-ready', reason: 'replica-set-required' });
    }
    return res.json({ status: 'ready', database: 'connected', transactions: 'supported' });
  } catch {
    return res.status(503).json({ status: 'not-ready', reason: 'database-check-failed' });
  }
});

router.use(requireAuth);

router.get('/wallet', async (req, res) => {
  const user = await User.findById(req.user._id);
  return res.json({
    user: user.toSafeJSON(),
    limits: { maxTransferPaise: env.MAX_TRANSFER_PAISE, offlineVoucherTtlHours: env.OFFLINE_VOUCHER_TTL_HOURS },
  });
});

router.get('/users/lookup', async (req, res) => {
  const handle = handleSchema.parse(req.query.handle);
  const user = await User.findOne({ handle }).select('displayName handle');
  if (!user) throw new AppError(404, 'RECIPIENT_NOT_FOUND', 'That handle is not registered.');
  if (user._id.equals(req.user._id)) throw new AppError(400, 'SELF_TRANSFER', 'You cannot send money to yourself.');
  res.json({ user: { displayName: user.displayName, handle: user.handle } });
});

router.post('/transfers', async (req, res) => {
  const input = transferSchema.parse(req.body);
  const { transfer, replayed } = await createOnlineTransfer({
    senderId: req.user._id.toString(),
    receiverHandle: input.receiverHandle,
    amountPaise: input.amountPaise,
    note: input.note,
    idempotencyKey: requireIdempotencyKey(req),
  });
  return res.status(replayed ? 200 : 201).json({ transfer: {
    transferId: transfer.transferId, amountPaise: transfer.amountPaise, kind: transfer.kind,
    status: transfer.status, note: transfer.note, createdAt: transfer.createdAt, replayed,
  } });
});

router.post('/offline/reserve', async (req, res) => {
  const input = reserveSchema.parse(req.body);
  const { transfer, replayed } = await reserveOfflineFunds({ userId: req.user._id.toString(), amountPaise: input.amountPaise, idempotencyKey: requireIdempotencyKey(req) });
  return res.status(replayed ? 200 : 201).json({ reserve: { transferId: transfer.transferId, amountPaise: transfer.amountPaise, replayed } });
});


router.post('/offline/release', async (req, res) => {
  z.object({}).strict().parse(req.body);
  const { transfer, replayed } = await releaseOfflineReserve({ userId: req.user._id.toString(), idempotencyKey: requireIdempotencyKey(req) });
  const current = await User.findById(req.user._id).select('offlineEpoch balancePaise offlineReservedPaise');
  return res.status(replayed ? 200 : 201).json({ release: {
    transferId: transfer.transferId, amountPaise: transfer.amountPaise, replayed,
    offlineEpoch: current.offlineEpoch, balancePaise: current.balancePaise, offlineReservedPaise: current.offlineReservedPaise,
  } });
});

router.post('/offline/devices', async (req, res) => {
  const input = deviceSchema.parse(req.body);
  const device = await registerDeviceKey({ userId: req.user._id.toString(), ...input });
  return res.status(200).json({ device: { deviceId: device.deviceId, createdAt: device.createdAt } });
});

router.get('/offline/contacts', async (req, res) => {
  const handle = handleSchema.parse(req.query.handle);
  const recipient = await User.findOne({ handle }).select('_id displayName handle');
  if (!recipient) throw new AppError(404, 'RECIPIENT_NOT_FOUND', 'That handle is not registered.');
  if (recipient._id.equals(req.user._id)) throw new AppError(400, 'SELF_TRANSFER', 'Choose another account as the offline recipient.');
  const devices = await DeviceKey.find({ user: recipient._id, encryptionPublicKeySpki: { $type: 'string' } })
    .sort({ lastSeenAt: -1 }).select('deviceId encryptionPublicKeySpki lastSeenAt').lean();
  if (!devices.length) throw new AppError(409, 'RECIPIENT_DEVICE_NOT_READY', 'The recipient must open MeshPay once while online to register an encryption key.');
  res.json({ contact: {
    handle: recipient.handle,
    displayName: recipient.displayName,
    devices: devices.map((device) => ({ deviceId: device.deviceId, encryptionPublicKeySpki: device.encryptionPublicKeySpki, lastSeenAt: device.lastSeenAt })),
  } });
});

router.get('/offline/status', async (req, res) => {
  const [devices, voucherCounts] = await Promise.all([
    DeviceKey.countDocuments({ user: req.user._id }),
    OfflineVoucher.aggregate([
      { $match: { sender: req.user._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);
  res.json({ offlineReservedPaise: req.user.offlineReservedPaise, offlineEpoch: req.user.offlineEpoch, registeredDevices: devices, voucherCounts: Object.fromEntries(voucherCounts.map((x) => [x._id, x.count])) });
});

router.post('/offline/sync', async (req, res) => {
  const packet = voucherSchema.parse(req.body);
  const result = await syncOfflineVoucher({ receiverUserId: req.user._id.toString(), packet });
  return res.status(result.status === 'rejected' ? 409 : 200).json({ voucher: result });
});

router.get('/transactions', async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit ?? '30', 10) || 30));
  const items = await Transfer.find({ $or: [{ sender: req.user._id }, { receiver: req.user._id }] })
    .sort({ createdAt: -1 }).limit(limit)
    .populate('sender', 'displayName handle')
    .populate('receiver', 'displayName handle')
    .lean();
  return res.json({ transactions: items.map((item) => ({
    transferId: item.transferId,
    amountPaise: item.amountPaise,
    kind: item.kind,
    status: item.status,
    note: item.note,
    direction: item.sender._id.toString() === req.user._id.toString() ? 'sent' : 'received',
    sender: { displayName: item.sender.displayName, handle: item.sender.handle },
    receiver: { displayName: item.receiver.displayName, handle: item.receiver.handle },
    createdAt: item.createdAt,
  })) });
});

router.get('/ledger', async (req, res) => {
  const entries = await LedgerEntry.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ entries: entries.map((entry) => ({ ...entry, id: entry._id.toString(), _id: undefined, user: undefined })) });
});

router.get('/ledger/reconcile', async (req, res) => {
  const session = await mongoose.startSession();
  let report;
  try {
    // Read account balances and ledger totals from one consistent database snapshot.
    await session.withTransaction(async () => {
      const user = await User.findById(req.user._id).session(session);
      if (!user) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account no longer exists.');
      const balances = await LedgerEntry.aggregate([
        { $match: { user: req.user._id } },
        { $group: {
          _id: '$bucket',
          ledgerPaise: { $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amountPaise', { $multiply: ['$amountPaise', -1] }] } },
          entries: { $sum: 1 },
        } },
      ]).session(session);
      const values = Object.fromEntries(balances.map((item) => [item._id, item]));
      const availableLedger = values.available?.ledgerPaise ?? 0;
      const reserveLedger = values['offline-reserve']?.ledgerPaise ?? 0;
      report = {
        consistent: availableLedger === user.balancePaise && reserveLedger === user.offlineReservedPaise,
        checkedAt: new Date().toISOString(),
        available: { accountPaise: user.balancePaise, ledgerPaise: availableLedger, deltaPaise: user.balancePaise - availableLedger, entries: values.available?.entries ?? 0 },
        offlineReserve: { accountPaise: user.offlineReservedPaise, ledgerPaise: reserveLedger, deltaPaise: user.offlineReservedPaise - reserveLedger, entries: values['offline-reserve']?.entries ?? 0 },
      };
    }, { readConcern: { level: 'snapshot' }, readPreference: 'primary' });
    res.json({ report });
  } finally {
    await session.endSession();
  }
});

router.get('/offline/vouchers', async (req, res) => {
  const items = await OfflineVoucher.find({ receiver: req.user._id }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ vouchers: items.map((item) => ({ voucherId: item.voucherId, amountPaise: item.amountPaise, status: item.status, rejectionCode: item.rejectionCode, transferId: item.transferId, createdAt: item.createdAt })) });
});

export default router;
