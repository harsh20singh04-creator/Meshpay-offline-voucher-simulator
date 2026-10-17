import { allowedOrigins } from '../config/env.js';
import { forbidden } from '../utils/AppError.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function originGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  // Modern browsers attach Fetch Metadata to requests. Reject cross-site mutations even if
  // an unusual client omits Origin; this complements SameSite cookies and origin allow-listing.
  if (req.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
    return next(forbidden('Cross-site state-changing requests are not allowed.'));
  }

  const origin = req.get('origin');
  // Mutating browser requests with an Origin must come from an explicitly allowed app origin.
  // Requests without Origin remain available to CLI/API clients; browsers use SameSite=Lax cookies.
  if (origin && !allowedOrigins.has(origin)) return next(forbidden('Request origin is not allowed.'));
  return next();
}
