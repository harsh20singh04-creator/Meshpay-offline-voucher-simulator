import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authRoutes from './routes/auth.routes.js';
import apiRoutes from './routes/api.routes.js';
import { originGuard } from './middleware/originGuard.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { env } from './config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const clientDistPath = path.resolve(__dirname, '../client/dist');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.NODE_ENV === 'production') app.set('trust proxy', 1);
  app.use((req, res, next) => {
    req.requestId = req.get('x-request-id')?.slice(0, 80) || randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        ...(env.NODE_ENV === 'production' ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use(cookieParser());
  app.use(originGuard);
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: env.NODE_ENV === 'test' ? 1000 : 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts. Try again later.' } } }));
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: env.NODE_ENV === 'test' ? 5000 : 180, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use('/api/auth', authRoutes);
  app.use('/api', apiRoutes);

  app.get('/api/health/live', (req, res) => res.json({ status: 'ok', service: 'upi-offline' }));

  app.use(express.static(clientDistPath, { index: false, maxAge: env.NODE_ENV === 'production' ? '1h' : 0, setHeaders(res, filePath) {
    if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
  } }));
  app.get('/{*splat}', (req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDistPath, 'index.html'), (error) => error && next(error));
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
