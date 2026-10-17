import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { canonicalJson, verifyEd25519Signature } from '../server/utils/crypto.js';

const { subtle } = webcrypto;
const base64 = (value) => Buffer.from(value).toString('base64');
const fromBase64 = (value) => Uint8Array.from(Buffer.from(value, 'base64'));

async function main() {
  // Sender signing keys mirror the server-registered Ed25519 SPKI identity.
  const signingPair = generateKeyPairSync('ed25519');
  const publicKeySpki = base64(signingPair.publicKey.export({ format: 'der', type: 'spki' }));
  const recipientKeys = await subtle.generateKey({
    name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, false, ['encrypt', 'decrypt']);
  const recipientDeviceId = '11111111-1111-4111-8111-111111111111';
  const recipientEncryptionPublicKeySpki = base64(await subtle.exportKey('spki', recipientKeys.publicKey));
  const importedRecipientPublicKey = await subtle.importKey(
    'spki', fromBase64(recipientEncryptionPublicKeySpki),
    { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'],
  );

  const payload = {
    voucherId: '22222222-2222-4222-8222-222222222222',
    deviceId: '33333333-3333-4333-8333-333333333333',
    sequence: 1,
    senderId: '0123456789abcdef01234567',
    offlineEpoch: 0,
    receiverHandle: 'recipient1',
    amountPaise: 12550,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    memo: 'crypto smoke test',
  };
  const signature = base64(signBytes(null, Buffer.from(canonicalJson(payload)), signingPair.privateKey));
  const signedPacket = { payload, signature, publicKeySpki };
  assert.equal(verifyEd25519Signature(publicKeySpki, canonicalJson(payload), signature), true, 'valid Ed25519 signature should verify on the server');
  assert.equal(verifyEd25519Signature(publicKeySpki, canonicalJson({ ...payload, amountPaise: 12551 }), signature), false, 'tampered payload must not verify on the server');

  // Also exercise the WebCrypto verification path used before a recipient stores an imported voucher.
  const browserSigningPublicKey = await subtle.importKey('spki', fromBase64(publicKeySpki), { name: 'Ed25519' }, false, ['verify']);
  const browserSignature = fromBase64(signature);
  const canonicalBytes = new TextEncoder().encode(canonicalJson(payload));
  assert.equal(await subtle.verify({ name: 'Ed25519' }, browserSigningPublicKey, browserSignature, canonicalBytes), true, 'WebCrypto should verify the valid signed voucher');
  assert.equal(await subtle.verify({ name: 'Ed25519' }, browserSigningPublicKey, browserSignature, new TextEncoder().encode(canonicalJson({ ...payload, amountPaise: 12551 }))), false, 'WebCrypto should reject a changed payload');

  // Browser-compatible hybrid envelope: AES-256-GCM data key wrapped using RSA-OAEP/SHA-256.
  const aesKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawAesKey = await subtle.exportKey('raw', aesKey);
  const wrappedKey = await subtle.encrypt({ name: 'RSA-OAEP' }, importedRecipientPublicKey, rawAesKey);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(canonicalJson({ version: 1, recipientDeviceId }));
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, aesKey, new TextEncoder().encode(JSON.stringify(signedPacket)));

  const unwrappedKey = await subtle.decrypt({ name: 'RSA-OAEP' }, recipientKeys.privateKey, wrappedKey);
  const importedAesKey = await subtle.importKey('raw', unwrappedKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const cleartext = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, importedAesKey, ciphertext);
  const decoded = JSON.parse(new TextDecoder().decode(cleartext));
  assert.deepEqual(decoded, signedPacket, 'recipient should recover the exact signed voucher');

  const tamperedCiphertext = new Uint8Array(ciphertext.slice(0));
  tamperedCiphertext[tamperedCiphertext.length - 1] ^= 1;
  await assert.rejects(
    subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, importedAesKey, tamperedCiphertext),
    'AES-GCM should reject modified ciphertext',
  );

  const wrongRecipientAad = new TextEncoder().encode(canonicalJson({ version: 1, recipientDeviceId: '44444444-4444-4444-8444-444444444444' }));
  await assert.rejects(
    subtle.decrypt({ name: 'AES-GCM', iv, additionalData: wrongRecipientAad, tagLength: 128 }, importedAesKey, ciphertext),
    'AES-GCM should reject a wrong recipient binding',
  );

  console.log('PASS crypto smoke test: Ed25519 signature, tamper rejection, RSA-OAEP/AES-GCM round-trip, ciphertext integrity, recipient binding');
}

main().catch((error) => {
  console.error('FAIL crypto smoke test:', error.message);
  process.exitCode = 1;
});
