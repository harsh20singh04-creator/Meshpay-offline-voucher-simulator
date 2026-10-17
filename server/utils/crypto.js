import { createHash, createPublicKey, verify as cryptoVerify, timingSafeEqual } from 'node:crypto';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function safeEqualText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyEd25519Signature(publicKeySpkiBase64, signedValue, signatureBase64) {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' });
    return cryptoVerify(null, Buffer.from(signedValue), publicKey, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
