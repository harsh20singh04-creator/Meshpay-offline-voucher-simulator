import { openDB } from 'idb';

const DB_NAME = 'meshpay-offline-vault';
const DB_VERSION = 2;
let dbPromise;
const pendingDeviceCreates = new Map();

function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains('devices')) database.createObjectStore('devices', { keyPath: 'userId' });
        if (!database.objectStoreNames.contains('vouchers')) database.createObjectStore('vouchers', { keyPath: 'voucherId' });
        if (!database.objectStoreNames.contains('contacts')) database.createObjectStore('contacts', { keyPath: 'contactKey' });
      },
    });
  }
  return dbPromise;
}

const toBase64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));
const fromBase64 = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(value)) throw new Error('Encrypted voucher contains invalid base64 data.');
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function createEncryptionKeyPair() {
  return crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
}

async function getOrCreateDevice(userId) {
  const database = await db();
  const existing = await database.get('devices', userId);
  if (existing?.keyPair && existing?.encryptionKeyPair) return existing;
  if (pendingDeviceCreates.has(userId)) return pendingDeviceCreates.get(userId);
  const creation = (async () => {
    const latest = await database.get('devices', userId);
    if (!globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID) throw new Error('This browser does not support secure offline cryptography. Use a recent browser on HTTPS or localhost.');
    if (latest?.keyPair) {
      latest.encryptionKeyPair = latest.encryptionKeyPair || await createEncryptionKeyPair();
      await database.put('devices', latest);
      return latest;
    }
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    const encryptionKeyPair = await createEncryptionKeyPair();
    const device = { userId, deviceId: crypto.randomUUID(), sequence: 0, keyPair, encryptionKeyPair, registeredAt: null, offlineEpoch: 0, epochReady: false, createdAt: new Date().toISOString() };
    await database.put('devices', device);
    return device;
  })();
  pendingDeviceCreates.set(userId, creation);
  try { return await creation; }
  finally { pendingDeviceCreates.delete(userId); }
}

export async function initializeOfflineDevice(user, apiPost, apiGet) {
  const database = await db();
  const device = await getOrCreateDevice(user.id);
  const publicKeySpki = toBase64(await crypto.subtle.exportKey('spki', device.keyPair.publicKey));
  const encryptionPublicKeySpki = toBase64(await crypto.subtle.exportKey('spki', device.encryptionKeyPair.publicKey));
  try {
    await apiPost('/api/offline/devices', { deviceId: device.deviceId, publicKeySpki, encryptionPublicKeySpki });
    device.registeredAt = device.registeredAt || new Date().toISOString();
    await database.put('devices', device);
    const status = await apiGet('/api/offline/status');
    device.offlineEpoch = status.offlineEpoch;
    device.epochReady = true;
    await database.put('devices', device);
    return { deviceId: device.deviceId, ready: true, offline: false, sequence: device.sequence, offlineEpoch: device.offlineEpoch };
  } catch (error) {
    if (error.code === 'NETWORK_UNAVAILABLE' && device.registeredAt && device.epochReady) return { deviceId: device.deviceId, ready: true, offline: true, sequence: device.sequence, offlineEpoch: device.offlineEpoch };
    throw error;
  }
}

export async function saveRecipientContact(userId, contact) {
  const database = await db();
  const handle = String(contact.handle || '').trim().toLowerCase();
  if (!handle || !Array.isArray(contact.devices) || !contact.devices.length) throw new Error('Recipient has no registered encryption device.');
  const record = { contactKey: `${userId}:${handle}`, userId, handle, displayName: contact.displayName || handle, devices: contact.devices, cachedAt: new Date().toISOString() };
  await database.put('contacts', record);
  return record;
}

export async function getRecipientContact(userId, handle) {
  return (await db()).get('contacts', `${userId}:${String(handle || '').trim().toLowerCase()}`);
}

export async function updateOfflineDeviceEpoch(userId, offlineEpoch) {
  const database = await db();
  const device = await database.get('devices', userId);
  if (!device) return;
  device.offlineEpoch = offlineEpoch;
  device.epochReady = true;
  await database.put('devices', device);
}

export async function getOfflineDeviceStatus(userId) {
  const device = await (await db()).get('devices', userId);
  return device ? { deviceId: device.deviceId, ready: Boolean(device.registeredAt && device.epochReady), sequence: device.sequence, offlineEpoch: device.offlineEpoch } : { deviceId: null, ready: false, sequence: 0 };
}

export async function createSignedVoucher({ user, receiverHandle, recipientDeviceId, recipientEncryptionPublicKeySpki, amountPaise, memo = '', ttlHours = 72 }) {
  if (!recipientDeviceId || !recipientEncryptionPublicKeySpki) throw new Error('Cache a registered recipient device key while online before creating an offline voucher.');
  const normalizedHandle = String(receiverHandle || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,22}[a-z0-9]$/.test(normalizedHandle)) throw new Error('Enter a valid recipient handle before creating a voucher.');
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error('Voucher amount must be a positive whole number of paise.');
  if (!Number.isSafeInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) throw new Error('Voucher validity must be between 1 and 168 hours.');
  const database = await db();
  const transaction = database.transaction('devices', 'readwrite');
  const device = await transaction.store.get(user.id);
  if (!device?.registeredAt || !device?.epochReady || !device?.keyPair || !device?.encryptionKeyPair) {
    transaction.abort();
    try { await transaction.done; } catch { /* Expected: we intentionally aborted the read/write transaction. */ }
    throw new Error('This device has not been registered while online yet. Connect once, open Offline Vault, and retry.');
  }
  device.sequence += 1;
  await transaction.store.put(device);
  await transaction.done;

  const issuedAt = new Date();
  const payload = {
    voucherId: crypto.randomUUID(),
    deviceId: device.deviceId,
    sequence: device.sequence,
    senderId: user.id,
    offlineEpoch: device.offlineEpoch ?? 0,
    receiverHandle: normalizedHandle,
    amountPaise,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlHours * 60 * 60 * 1000).toISOString(),
    memo: memo.trim().slice(0, 100),
  };
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const signature = toBase64(await crypto.subtle.sign({ name: 'Ed25519' }, device.keyPair.privateKey, bytes));
  const publicKeySpki = toBase64(await crypto.subtle.exportKey('spki', device.keyPair.publicKey));
  const signedPacket = { payload, signature, publicKeySpki };

  // Hybrid encryption: RSA-OAEP wraps a fresh AES-256 key; AES-GCM encrypts the signed voucher.
  // The authenticated additional data binds the ciphertext to the intended recipient device.
  const recipientPublicKey = await crypto.subtle.importKey('spki', fromBase64(recipientEncryptionPublicKeySpki), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
  const wrappedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, recipientPublicKey, rawAesKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(canonicalJson({ version: 1, recipientDeviceId }));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, aesKey, new TextEncoder().encode(JSON.stringify(signedPacket)));
  const packet = { envelope: { version: 1, recipientDeviceId, iv: toBase64(iv), wrappedKey: toBase64(wrappedKey), ciphertext: toBase64(ciphertext) } };
  await database.put('vouchers', { voucherId: payload.voucherId, direction: 'outgoing', status: 'awaiting-handoff', packet, voucherPayload: payload, recipientDeviceId, createdAt: new Date().toISOString() });
  return packet;
}

export async function importVoucherPacket(text, currentUser) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 32 * 1024) {
    throw new Error('Voucher packet must be non-empty and no larger than 32 KB.');
  }
  let envelopePacket;
  try { envelopePacket = JSON.parse(text); } catch { throw new Error('Paste a valid voucher JSON object.'); }
  const envelope = envelopePacket?.envelope;
  if (envelope?.version !== 1 || typeof envelope.recipientDeviceId !== 'string' || typeof envelope.iv !== 'string' || typeof envelope.wrappedKey !== 'string' || typeof envelope.ciphertext !== 'string' || envelope.iv.length > 64 || envelope.wrappedKey.length > 2048 || envelope.ciphertext.length > 24000) {
    throw new Error('This does not look like a supported encrypted MeshPay voucher.');
  }
  const database = await db();
  const device = await database.get('devices', currentUser.id);
  if (!device?.encryptionKeyPair?.privateKey || device.deviceId !== envelope.recipientDeviceId) {
    throw new Error('This encrypted voucher is addressed to a different device. Initialize this account on this browser while online before receiving offline vouchers.');
  }

  let packet;
  try {
    const rawAesKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, device.encryptionKeyPair.privateKey, fromBase64(envelope.wrappedKey));
    const aesKey = await crypto.subtle.importKey('raw', rawAesKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const aad = new TextEncoder().encode(canonicalJson({ version: 1, recipientDeviceId: envelope.recipientDeviceId }));
    const cleartext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData: aad, tagLength: 128 }, aesKey, fromBase64(envelope.ciphertext));
    packet = JSON.parse(new TextDecoder().decode(cleartext));
  } catch {
    throw new Error('Voucher decryption failed. The packet may be corrupted, altered, or intended for another device.');
  }

  const payload = packet?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof packet.signature !== 'string' || packet.signature.length > 256 || !/^[A-Za-z0-9+/]+=*$/.test(packet.signature) || typeof packet.publicKeySpki !== 'string' || packet.publicKeySpki.length > 512 || !/^[A-Za-z0-9+/]+=*$/.test(packet.publicKeySpki)) {
    throw new Error('Decrypted voucher contents are malformed.');
  }
  const isUuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const expectedFields = ['amountPaise', 'deviceId', 'expiresAt', 'issuedAt', 'memo', 'offlineEpoch', 'receiverHandle', 'senderId', 'sequence', 'voucherId'];
  const payloadFields = Object.keys(payload).sort();
  if (payloadFields.join('|') !== expectedFields.join('|') || !isUuid(payload.voucherId) || !isUuid(payload.deviceId) || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1 || typeof payload.senderId !== 'string' || !/^[a-f\d]{24}$/i.test(payload.senderId) || !Number.isSafeInteger(payload.offlineEpoch) || payload.offlineEpoch < 0 || typeof payload.receiverHandle !== 'string' || !Number.isSafeInteger(payload.amountPaise) || payload.amountPaise < 1 || typeof payload.issuedAt !== 'string' || !Number.isFinite(Date.parse(payload.issuedAt)) || typeof payload.expiresAt !== 'string' || !Number.isFinite(Date.parse(payload.expiresAt)) || typeof payload.memo !== 'string' || payload.memo.length > 100) {
    throw new Error('Decrypted voucher payload does not match the supported format.');
  }

  // Verify the signed contents before adding them to the local pending queue. This does not
  // replace server verification: the server additionally checks that this public key is the
  // one registered to the claimed sender device.
  let signatureValid = false;
  try {
    const signingPublicKey = await crypto.subtle.importKey('spki', fromBase64(packet.publicKeySpki), { name: 'Ed25519' }, false, ['verify']);
    signatureValid = await crypto.subtle.verify(
      { name: 'Ed25519' }, signingPublicKey, fromBase64(packet.signature),
      new TextEncoder().encode(canonicalJson(payload)),
    );
  } catch {
    throw new Error('Voucher signing key or signature is malformed.');
  }
  if (!signatureValid) throw new Error('Voucher signature verification failed. The packet may be altered or forged.');

  if (!/^[a-z0-9][a-z0-9._-]{1,22}[a-z0-9]$/.test(payload.receiverHandle.toLowerCase())) throw new Error('Voucher recipient handle is invalid.');
  if (payload.receiverHandle.toLowerCase() !== currentUser.handle.toLowerCase()) throw new Error(`This voucher is addressed to @${payload.receiverHandle}, not your account @${currentUser.handle}.`);
  console.log('Import check:', {
  voucherId: payload.voucherId,
  currentExists: Boolean(await database.get('vouchers', payload.voucherId)),
  receiver: payload.receiverHandle,
  currentUser: currentUser.handle
});
  const current = await database.get('vouchers', payload.voucherId);
  if (current && canonicalJson(current.packet) !== canonicalJson(packet)) throw new Error('This voucher ID already exists locally with different contents.');
  if (!current) await database.put('vouchers', { voucherId: payload.voucherId, direction: 'incoming', receiverUserId: currentUser.id, status: 'pending-sync', packet, envelope: envelopePacket, voucherPayload: payload, createdAt: new Date().toISOString() });
  return { duplicate: Boolean(current), voucherId: payload.voucherId };
}

export async function listLocalVouchers(userId) {
  const all = await (await db()).getAll('vouchers');
  return all.filter((item) => item.voucherPayload?.senderId === userId || (item.direction === 'incoming' && item.receiverUserId === userId));
}

export async function syncIncomingVouchers(user, syncRequest) {
  const database = await db();
  const items = (await database.getAll('vouchers')).filter((item) => item.direction === 'incoming' && item.status === 'pending-sync' && item.receiverUserId === user.id);
  const results = [];
  for (const item of items) {
    try {
      const result = await syncRequest(item.packet);
      const voucher = result.voucher || result;
      item.status = voucher.status === 'rejected' ? 'rejected' : 'settled';
      item.serverResult = voucher;
      item.syncedAt = new Date().toISOString();
      await database.put('vouchers', item);
      results.push({ voucherId: item.voucherId, status: item.status, message: item.status === 'settled' ? 'Voucher settled.' : voucher.rejectionCode || 'Voucher rejected.' });
    } catch (error) {
      const voucher = error.payload?.voucher;
      if (voucher) {
        item.status = voucher.status === 'rejected' ? 'rejected' : 'settled';
        item.serverResult = voucher;
        item.syncedAt = new Date().toISOString();
        await database.put('vouchers', item);
        results.push({ voucherId: item.voucherId, status: item.status, message: voucher.rejectionCode || error.message });
      } else if (error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status)) {
        item.status = 'rejected';
        item.serverResult = { rejectionCode: error.code || 'VOUCHER_REJECTED', message: error.message };
        item.syncedAt = new Date().toISOString();
        await database.put('vouchers', item);
        results.push({ voucherId: item.voucherId, status: 'rejected', message: error.message });
      } else {
        results.push({ voucherId: item.voucherId, status: 'pending-sync', message: error.message });
      }
    }
  }
  return results;
}

export async function exportVoucher(item) {
  return JSON.stringify(item.packet, null, 2);
}
