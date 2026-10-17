import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { LedgerEntry } from '../models/LedgerEntry.js';
import { AppError, conflict, unauthorized } from '../utils/AppError.js';

export async function registerUser({ displayName, handle, password }) {
  const passwordHash = await bcrypt.hash(password, 12);
  const session = await mongoose.startSession();
  let createdUser;
  try {
    await session.withTransaction(async () => {
      const [user] = await User.create([{
        displayName: displayName.trim(),
        handle: handle.toLowerCase(),
        passwordHash,
        balancePaise: env.DEMO_STARTING_BALANCE_PAISE,
        offlineReservedPaise: 0,
      }], { session });
      if (env.DEMO_STARTING_BALANCE_PAISE > 0) {
        await LedgerEntry.create([{
          transferId: `opening:${user._id}`,
          user: user._id,
          bucket: 'available',
          direction: 'credit',
          amountPaise: env.DEMO_STARTING_BALANCE_PAISE,
          balanceAfterPaise: env.DEMO_STARTING_BALANCE_PAISE,
        }], { session });
      }
      createdUser = user;
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    return createdUser;
  } catch (error) {
    if (error?.code === 11000) throw conflict('HANDLE_TAKEN', 'That handle is already registered. Choose another.');
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function authenticateUser({ handle, password }) {
  const user = await User.findOne({ handle: handle.toLowerCase() }).select('+passwordHash');
  const matches = user ? await bcrypt.compare(password, user.passwordHash) : await bcrypt.compare(password, '$2a$12$C6UzMDM.H6dfI/f/IKcEe.ouEFe7g5zDGMgU6Do3tq0wYd6t3vZ7y');
  if (!user || !matches) throw unauthorized('Incorrect handle or password.');
  return user;
}

export function createSessionToken(userId) {
  return jwt.sign({}, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: userId.toString(),
    issuer: 'upi-offline',
    audience: 'upi-offline-web',
    expiresIn: env.JWT_TTL,
  });
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 12 * 60 * 60 * 1000,
  };
}
