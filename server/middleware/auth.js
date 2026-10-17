import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { unauthorized } from '../utils/AppError.js';

export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[env.COOKIE_NAME];
    if (!token) throw unauthorized();
    let claims;
    try {
      claims = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'upi-offline', audience: 'upi-offline-web' });
    } catch {
      throw unauthorized('Session expired. Please sign in again.');
    }
    const user = await User.findById(claims.sub);
    if (!user) throw unauthorized('Session is no longer valid.');
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}
