export class ApiError extends Error {
  constructor(status, code, message, payload = null) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'REQUEST_FAILED';
    this.payload = payload;
  }
}

export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'include',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_UNAVAILABLE', 'Network unavailable. Your local offline vault remains on this device.');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.error || payload.voucher || {};
    throw new ApiError(response.status, error.code || error.rejectionCode || 'REQUEST_FAILED', error.message || error.rejectionCode || 'Request failed.', payload);
  }
  return payload;
}

export const postJson = (path, body, headers = {}) => api(path, { method: 'POST', body: JSON.stringify(body), headers });
export const rupeesToPaise = (amount) => {
  const text = String(amount ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [wholePart, fractionPart = ''] = text.split('.');
  const whole = Number(wholePart);
  const fraction = Number(fractionPart.padEnd(2, '0'));
  const paise = whole * 100 + fraction;
  if (!Number.isSafeInteger(paise) || paise <= 0) return null;
  return paise;
};
export const formatINR = (paise = 0) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format((Number(paise) || 0) / 100);
export const formatDate = (value) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
