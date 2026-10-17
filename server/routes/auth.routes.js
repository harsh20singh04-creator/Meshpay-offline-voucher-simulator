import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { authenticateUser, createSessionToken, registerUser, sessionCookieOptions } from '../services/auth.service.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

const router = Router();
const handleSchema = z.string().trim().toLowerCase().min(3).max(24).regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/);
const registerSchema = z.object({
  displayName: z.string().trim().min(2).max(60),
  handle: handleSchema,
  password: z.string().min(10).max(72),
}).strict();
const loginSchema = z.object({ handle: handleSchema, password: z.string().min(1).max(72) }).strict();

function respondWithSession(res, user) {
  res.cookie(env.COOKIE_NAME, createSessionToken(user._id), sessionCookieOptions());
  return res.json({ user: user.toSafeJSON() });
}

router.post('/register', async (req, res) => {
  const input = registerSchema.parse(req.body);
  const user = await registerUser(input);
  return respondWithSession(res, user);
});

router.post('/login', async (req, res) => {
  const input = loginSchema.parse(req.body);
  const user = await authenticateUser(input);
  return respondWithSession(res, user);
});

router.post('/logout', (req, res) => {
  res.clearCookie(env.COOKIE_NAME, { ...sessionCookieOptions(), maxAge: undefined });
  return res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user.toSafeJSON() }));

export default router;
