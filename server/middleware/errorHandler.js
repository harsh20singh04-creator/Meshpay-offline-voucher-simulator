import { ZodError } from 'zod';
import { AppError } from '../utils/AppError.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  // Express/body-parser parser errors are expected client mistakes, not server failures.
  if (error?.type === 'entity.parse.failed' || (error instanceof SyntaxError && Object.hasOwn(error, 'body'))) {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must contain valid JSON.' } });
  }
  if (error?.type === 'entity.too.large' || error?.status === 413) {
    return res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Request body exceeds the 32 KB limit.' } });
  }
  if (error instanceof ZodError) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Check the submitted fields.', details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } });
  }
  if (error?.code === 11000) {
    return res.status(409).json({ error: { code: 'DUPLICATE_RESOURCE', message: 'This operation conflicts with an existing record.' } });
  }
  if (error instanceof AppError) {
    return res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
  }
  if (error?.name === 'MongoServerError' && error?.code === 251) {
    return res.status(503).json({ error: { code: 'TRANSACTION_RETRY_REQUIRED', message: 'Database transaction could not be completed; safely retry using the same idempotency key.' } });
  }
  if (['MongooseServerSelectionError', 'MongoNetworkError', 'MongoTopologyClosedError'].includes(error?.name)) {
    return res.status(503).json({ error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is temporarily unavailable. Retry safely using the same idempotency key.' } });
  }
  // Do not leak stack traces, query contents, secrets or internal errors to clients.
  console.error(JSON.stringify({ level: 'error', event: 'unhandled_error', requestId: req.requestId, name: error?.name, message: error?.message }));
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Retry safely using the same idempotency key.' } });
}
