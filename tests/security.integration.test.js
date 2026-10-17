import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { generateKeyPairSync, sign as signBytes, randomUUID } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-with-at-least-thirty-two-bytes';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/upi_offline_test?replicaSet=rs0';
process.env.APP_ORIGIN = 'http://localhost:5173,http://localhost:5000';
process.env.DEMO_STARTING_BALANCE_PAISE = '500000';
process.env.MAX_TRANSFER_PAISE = '2000000';
process.env.OFFLINE_VOUCHER_TTL_HOURS = '72';

let replset;
let app;
let mongoose;
let models;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function register(agent, displayName, handle) {
  const response = await agent.post('/api/auth/register').send({ displayName, handle, password: 'correct horse battery' });
  expect(response.status).toBe(200);
  return response.body.user;
}

beforeAll(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGODB_URI = replset.getUri('upi_offline_test');
  const imported = await import('../server/app.js');
  app = imported.createApp();
  const dbModule = await import('../server/config/db.js');
  await dbModule.connectDatabase();
  mongoose = (await import('mongoose')).default;
  models = await Promise.all([
    import('../server/models/User.js'), import('../server/models/Transfer.js'),
    import('../server/models/LedgerEntry.js'), import('../server/models/DeviceKey.js'),
    import('../server/models/OfflineVoucher.js'),
  ]);
  // `connectDatabase` initialized the application models and their unique indexes.
});

afterAll(async () => {
  if (mongoose) await mongoose.disconnect();
  if (replset) await replset.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await Promise.all(models.flatMap((module) => Object.values(module).filter((value) => value?.syncIndexes).map((model) => model.syncIndexes())));
});

describe('payment safety invariants', () => {
  it('requires an authenticated session for wallet data', async () => {
    const response = await request(app).get('/api/wallet').expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects mutations carrying an unapproved browser Origin', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .set('Origin', 'https://attacker.example')
      .send({ displayName: 'Attacker', handle: 'attacker', password: 'correct horse battery' })
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects cross-site state-changing requests using Fetch Metadata even if Origin is absent', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ displayName: 'Attacker', handle: 'attacker', password: 'correct horse battery' })
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('sets baseline security headers on API responses', async () => {
    const response = await request(app).get('/api/health/live').expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBeTruthy();
  });

  it('returns a clear 400 for malformed JSON instead of a server error', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"handle":');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects oversized JSON requests with a clear 413', async () => {
    const oversized = JSON.stringify({ padding: 'x'.repeat(33 * 1024) });
    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(oversized)
      .expect(413);
    expect(response.body.error.code).toBe('BODY_TOO_LARGE');
  });

  it('reserves funds exactly once when the same idempotency key is retried', async () => {
    const aliceAgent = request.agent(app);
    const alice = await register(aliceAgent, 'Alice Example', 'alice');
    const key = `reserve:${randomUUID()}`;
    const first = await aliceAgent.post('/api/offline/reserve').set('Idempotency-Key', key).send({ amountPaise: 10000 }).expect(201);
    const retry = await aliceAgent.post('/api/offline/reserve').set('Idempotency-Key', key).send({ amountPaise: 10000 }).expect(200);
    expect(retry.body.reserve.transferId).toBe(first.body.reserve.transferId);
    expect(retry.body.reserve.replayed).toBe(true);
    const wallet = (await aliceAgent.get('/api/wallet')).body.user;
    expect(wallet.balancePaise).toBe(alice.balancePaise - 10000);
    expect(wallet.offlineReservedPaise).toBe(10000);
    const changedPayload = await aliceAgent.post('/api/offline/reserve').set('Idempotency-Key', key).send({ amountPaise: 12000 }).expect(409);
    expect(changedPayload.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('registers RSA recipient keys and returns them only as contact key material', async () => {
    const aliceAgent = request.agent(app);
    const bobAgent = request.agent(app);
    await register(aliceAgent, 'Alice Example', 'alice');
    await register(bobAgent, 'Bob Example', 'bob');
    const signingPair = generateKeyPairSync('ed25519');
    const encryptionPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const deviceId = randomUUID();
    const publicKeySpki = signingPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const encryptionPublicKeySpki = encryptionPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await bobAgent.post('/api/offline/devices').send({ deviceId, publicKeySpki, encryptionPublicKeySpki }).expect(200);

    const contact = await aliceAgent.get('/api/offline/contacts?handle=bob').expect(200);
    expect(contact.body.contact.handle).toBe('bob');
    expect(contact.body.contact.devices).toHaveLength(1);
    expect(contact.body.contact.devices[0].deviceId).toBe(deviceId);
    expect(contact.body.contact.devices[0].encryptionPublicKeySpki).toBe(encryptionPublicKeySpki);
    await aliceAgent.get('/api/offline/contacts?handle=alice').expect(400);

    const invalidAgent = request.agent(app);
    await register(invalidAgent, 'Cara Example', 'cara');
    await invalidAgent.post('/api/offline/devices').send({
      deviceId: randomUUID(), publicKeySpki,
      encryptionPublicKeySpki: publicKeySpki,
    }).expect(400);
  });
  it('settles an online transfer exactly once when the same idempotency key is retried', async () => {
    const aliceAgent = request.agent(app);
    const bobAgent = request.agent(app);
    const alice = await register(aliceAgent, 'Alice Example', 'alice');
    await register(bobAgent, 'Bob Example', 'bob');
    const beforeBob = (await bobAgent.get('/api/wallet')).body.user.balancePaise;
    expect((await aliceAgent.get('/api/offline/status')).body.offlineEpoch).toBe(0);
    const reconciliationBefore = await aliceAgent.get('/api/ledger/reconcile').expect(200);
    expect(reconciliationBefore.body.report.consistent).toBe(true);
    const key = `online:${randomUUID()}`;
    const first = await aliceAgent.post('/api/transfers').set('Idempotency-Key', key).send({ receiverHandle: 'bob', amountPaise: 12000, note: 'lunch' });
    expect(first.status).toBe(201);
    const retry = await aliceAgent.post('/api/transfers').set('Idempotency-Key', key).send({ receiverHandle: 'bob', amountPaise: 12000, note: 'lunch' });
    expect(retry.status).toBe(200);
    expect(retry.body.transfer.transferId).toBe(first.body.transfer.transferId);
    expect(retry.body.transfer.replayed).toBe(true);
    const afterAlice = (await aliceAgent.get('/api/wallet')).body.user.balancePaise;
    const afterBob = (await bobAgent.get('/api/wallet')).body.user.balancePaise;
    expect(afterAlice).toBe(alice.balancePaise - 12000);
    expect(afterBob).toBe(beforeBob + 12000);
    const transfers = await models[1].Transfer.find({ kind: 'online' });
    expect(transfers).toHaveLength(1);
    const reconciliationAfter = await aliceAgent.get('/api/ledger/reconcile').expect(200);
    expect(reconciliationAfter.body.report.consistent).toBe(true);
  });

  it('settles concurrent retries with the same idempotency key only once', async () => {
    const aliceAgent = request.agent(app);
    const bobAgent = request.agent(app);
    const alice = await register(aliceAgent, 'Alice Example', 'alice');
    const bob = await register(bobAgent, 'Bob Example', 'bob');
    const key = `race:${randomUUID()}`;
    const payload = { receiverHandle: 'bob', amountPaise: 15000, note: 'same logical payment' };
    const [first, second] = await Promise.all([
      aliceAgent.post('/api/transfers').set('Idempotency-Key', key).send(payload),
      aliceAgent.post('/api/transfers').set('Idempotency-Key', key).send(payload),
    ]);
    expect([first.status, second.status].every((status) => [200, 201].includes(status))).toBe(true);
    expect(first.body.transfer.transferId).toBe(second.body.transfer.transferId);
    expect([first.body.transfer.replayed, second.body.transfer.replayed].filter(Boolean)).toHaveLength(1);
    expect((await aliceAgent.get('/api/wallet')).body.user.balancePaise).toBe(alice.balancePaise - 15000);
    expect((await bobAgent.get('/api/wallet')).body.user.balancePaise).toBe(bob.balancePaise + 15000);
    expect(await models[1].Transfer.countDocuments({ kind: 'online' })).toBe(1);
  });

  it('rejects reusing an idempotency key with a different payment payload', async () => {
    const aliceAgent = request.agent(app);
    const bobAgent = request.agent(app);
    await register(aliceAgent, 'Alice Example', 'alice');
    await register(bobAgent, 'Bob Example', 'bob');
    const key = `online:${randomUUID()}`;
    expect((await aliceAgent.post('/api/transfers').set('Idempotency-Key', key).send({ receiverHandle: 'bob', amountPaise: 5000, note: '' })).status).toBe(201);
    const altered = await aliceAgent.post('/api/transfers').set('Idempotency-Key', key).send({ receiverHandle: 'bob', amountPaise: 6000, note: '' });
    expect(altered.status).toBe(409);
    expect(altered.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('prevents concurrent transfers from spending the same available balance twice', async () => {
    const aliceAgent = request.agent(app);
    const bobAgent = request.agent(app);
    const caraAgent = request.agent(app);
    await register(aliceAgent, 'Alice Example', 'alice');
    await register(bobAgent, 'Bob Example', 'bob');
    await register(caraAgent, 'Cara Example', 'cara');
    const [first, second] = await Promise.all([
      aliceAgent.post('/api/transfers').set('Idempotency-Key', `online:${randomUUID()}`).send({ receiverHandle: 'bob', amountPaise: 400000, note: '' }),
      aliceAgent.post('/api/transfers').set('Idempotency-Key', `online:${randomUUID()}`).send({ receiverHandle: 'cara', amountPaise: 400000, note: '' }),
    ]);
    expect([first.status, second.status].filter((status) => status === 201)).toHaveLength(1);
    expect([first.status, second.status].filter((status) => status === 409)).toHaveLength(1);
    const balance = (await aliceAgent.get('/api/wallet')).body.user.balancePaise;
    expect(balance).toBe(100000);
  });

  it('prevents concurrent online spending and offline reservation from overspending the same funds', async () => {
    const aliceAgent = request.agent(app);
    const bobAgent = request.agent(app);
    const alice = await register(aliceAgent, 'Alice Example', 'alice');
    await register(bobAgent, 'Bob Example', 'bob');
    const [transfer, reserve] = await Promise.all([
      aliceAgent.post('/api/transfers')
        .set('Idempotency-Key', `online:${randomUUID()}`)
        .send({ receiverHandle: 'bob', amountPaise: 400000, note: 'concurrent channel test' }),
      aliceAgent.post('/api/offline/reserve')
        .set('Idempotency-Key', `reserve:${randomUUID()}`)
        .send({ amountPaise: 400000 }),
    ]);
    expect([transfer.status, reserve.status].filter((status) => status === 201)).toHaveLength(1);
    expect([transfer.status, reserve.status].filter((status) => status === 409)).toHaveLength(1);
    const wallet = (await aliceAgent.get('/api/wallet')).body.user;
    expect(wallet.balancePaise).toBeGreaterThanOrEqual(0);
    expect(wallet.balancePaise + wallet.offlineReservedPaise).toBe(alice.balancePaise - (transfer.status === 201 ? 400000 : 0));
  });

  it('verifies offline signatures and prevents replay from crediting the receiver twice', async () => {
    const aliceAgent = request.agent(app);
    const bobAgent = request.agent(app);
    const alice = await register(aliceAgent, 'Alice Example', 'alice');
    const bob = await register(bobAgent, 'Bob Example', 'bob');
    await aliceAgent.post('/api/offline/reserve').set('Idempotency-Key', `reserve:${randomUUID()}`).send({ amountPaise: 20000 }).expect(201);

    const pair = generateKeyPairSync('ed25519');
    const encryptionPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const deviceId = randomUUID();
    const publicKeySpki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const encryptionPublicKeySpki = encryptionPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await aliceAgent.post('/api/offline/devices').send({ deviceId, publicKeySpki, encryptionPublicKeySpki }).expect(200);
    const now = new Date();
    const payload = {
      voucherId: randomUUID(), deviceId, sequence: 1, senderId: alice.id, offlineEpoch: 0, receiverHandle: 'bob', amountPaise: 7000,
      issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString(), memo: 'offline test',
    };
    const signature = signBytes(null, Buffer.from(canonicalJson(payload)), pair.privateKey).toString('base64');
    const packet = { payload, signature, publicKeySpki };
    const first = await bobAgent.post('/api/offline/sync').send(packet).expect(200);
    expect(first.body.voucher.status).toBe('settled');
    const replay = await bobAgent.post('/api/offline/sync').send(packet).expect(200);
    expect(replay.body.voucher.duplicate).toBe(true);
    const bobBalance = (await bobAgent.get('/api/wallet')).body.user.balancePaise;
    const aliceAfter = (await aliceAgent.get('/api/wallet')).body.user;
    expect(bobBalance).toBe(bob.balancePaise + 7000);
    expect(aliceAfter.offlineReservedPaise).toBe(13000);
    expect(await models[4].OfflineVoucher.countDocuments({ voucherId: payload.voucherId })).toBe(1);
  });


  it('rejects voucher ID reuse when the signed contents change', async () => {
    const aliceAgent = request.agent(app);
    const bobAgent = request.agent(app);
    const alice = await register(aliceAgent, 'Alice Example', 'alice');
    await register(bobAgent, 'Bob Example', 'bob');
    await aliceAgent.post('/api/offline/reserve').set('Idempotency-Key', `reserve:${randomUUID()}`).send({ amountPaise: 10000 }).expect(201);

    const pair = generateKeyPairSync('ed25519');
    const encryptionPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const deviceId = randomUUID();
    const publicKeySpki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const encryptionPublicKeySpki = encryptionPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await aliceAgent.post('/api/offline/devices').send({ deviceId, publicKeySpki, encryptionPublicKeySpki }).expect(200);
    const now = new Date();
    const payload = { voucherId: randomUUID(), deviceId, sequence: 1, senderId: alice.id, offlineEpoch: 0, receiverHandle: 'bob', amountPaise: 3000, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString(), memo: 'original' };
    const signature = (value) => signBytes(null, Buffer.from(canonicalJson(value)), pair.privateKey).toString('base64');
    await bobAgent.post('/api/offline/sync').send({ payload, signature: signature(payload), publicKeySpki }).expect(200);

    const changed = { ...payload, amountPaise: 4000, memo: 'changed' };
    const response = await bobAgent.post('/api/offline/sync').send({ payload: changed, signature: signature(changed), publicKeySpki }).expect(409);
    expect(response.body.error.code).toBe('VOUCHER_ID_REUSED');
    expect((await bobAgent.get('/api/wallet')).body.user.balancePaise).toBe(503000);
    expect((await aliceAgent.get('/api/wallet')).body.user.offlineReservedPaise).toBe(7000);
  });

  it('will not let a different account claim a voucher addressed to another handle', async () => {
    const aliceAgent = request.agent(app);
    const bobAgent = request.agent(app);
    const caraAgent = request.agent(app);
    const alice = await register(aliceAgent, 'Alice Example', 'alice');
    await register(bobAgent, 'Bob Example', 'bob');
    const cara = await register(caraAgent, 'Cara Example', 'cara');
    await aliceAgent.post('/api/offline/reserve').set('Idempotency-Key', `reserve:${randomUUID()}`).send({ amountPaise: 10000 }).expect(201);
    const signingPair = generateKeyPairSync('ed25519');
    const encryptionPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const deviceId = randomUUID();
    const publicKeySpki = signingPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const encryptionPublicKeySpki = encryptionPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await aliceAgent.post('/api/offline/devices').send({ deviceId, publicKeySpki, encryptionPublicKeySpki }).expect(200);
    const now = new Date();
    const payload = {
      voucherId: randomUUID(), deviceId, sequence: 1, senderId: alice.id, offlineEpoch: 0,
      receiverHandle: 'bob', amountPaise: 7000, issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600000).toISOString(), memo: 'receiver binding test',
    };
    const signature = signBytes(null, Buffer.from(canonicalJson(payload)), signingPair.privateKey).toString('base64');
    const response = await caraAgent.post('/api/offline/sync').send({ payload, signature, publicKeySpki }).expect(403);
    expect(response.body.error.code).toBe('WRONG_RECIPIENT');
    expect((await caraAgent.get('/api/wallet')).body.user.balancePaise).toBe(cara.balancePaise);
    expect((await aliceAgent.get('/api/wallet')).body.user.offlineReservedPaise).toBe(10000);
    expect(await models[4].OfflineVoucher.countDocuments({ voucherId: payload.voucherId })).toBe(0);
  });

  it('settles concurrent submissions of the same offline voucher only once', async () => {
    const aliceAgent = request.agent(app);
    const bobAgent = request.agent(app);
    const alice = await register(aliceAgent, 'Alice Example', 'alice');
    const bob = await register(bobAgent, 'Bob Example', 'bob');
    await aliceAgent.post('/api/offline/reserve').set('Idempotency-Key', `reserve:${randomUUID()}`).send({ amountPaise: 20000 }).expect(201);

    const signingPair = generateKeyPairSync('ed25519');
    const encryptionPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const deviceId = randomUUID();
    const publicKeySpki = signingPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const encryptionPublicKeySpki = encryptionPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await aliceAgent.post('/api/offline/devices').send({ deviceId, publicKeySpki, encryptionPublicKeySpki }).expect(200);
    const now = new Date();
    const payload = {
      voucherId: randomUUID(), deviceId, sequence: 1, senderId: alice.id, offlineEpoch: 0,
      receiverHandle: 'bob', amountPaise: 7000, issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600000).toISOString(), memo: 'concurrency test',
    };
    const signature = signBytes(null, Buffer.from(canonicalJson(payload)), signingPair.privateKey).toString('base64');
    const packet = { payload, signature, publicKeySpki };
    const [first, second] = await Promise.all([
      bobAgent.post('/api/offline/sync').send(packet),
      bobAgent.post('/api/offline/sync').send(packet),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.voucher.transferId).toBe(second.body.voucher.transferId);
    expect([first.body.voucher.duplicate, second.body.voucher.duplicate].filter(Boolean)).toHaveLength(1);
    expect((await bobAgent.get('/api/wallet')).body.user.balancePaise).toBe(bob.balancePaise + 7000);
    expect((await aliceAgent.get('/api/wallet')).body.user.offlineReservedPaise).toBe(13000);
    expect(await models[4].OfflineVoucher.countDocuments({ voucherId: payload.voucherId })).toBe(1);
  });

  it('records a valid voucher rejected for insufficient reserve without crediting the receiver', async () => {
    const aliceAgent = request.agent(app);
    const bobAgent = request.agent(app);
    const alice = await register(aliceAgent, 'Alice Example', 'alice');
    const bob = await register(bobAgent, 'Bob Example', 'bob');
    const signingPair = generateKeyPairSync('ed25519');
    const encryptionPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const deviceId = randomUUID();
    const publicKeySpki = signingPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const encryptionPublicKeySpki = encryptionPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await aliceAgent.post('/api/offline/devices').send({ deviceId, publicKeySpki, encryptionPublicKeySpki }).expect(200);
    const now = new Date();
    const payload = {
      voucherId: randomUUID(), deviceId, sequence: 1, senderId: alice.id, offlineEpoch: 0,
      receiverHandle: 'bob', amountPaise: 7000, issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600000).toISOString(), memo: 'no reserve test',
    };
    const signature = signBytes(null, Buffer.from(canonicalJson(payload)), signingPair.privateKey).toString('base64');
    const packet = { payload, signature, publicKeySpki };
    const first = await bobAgent.post('/api/offline/sync').send(packet).expect(409);
    expect(first.body.voucher.status).toBe('rejected');
    expect(first.body.voucher.rejectionCode).toBe('INSUFFICIENT_OFFLINE_RESERVE');
    const retry = await bobAgent.post('/api/offline/sync').send(packet).expect(409);
    expect(retry.body.voucher.duplicate).toBe(true);
    expect((await bobAgent.get('/api/wallet')).body.user.balancePaise).toBe(bob.balancePaise);
    expect((await aliceAgent.get('/api/wallet')).body.user.offlineReservedPaise).toBe(0);
    expect(await models[4].OfflineVoucher.countDocuments({ voucherId: payload.voucherId })).toBe(1);
  });

  it('rejects a new voucher ID that reuses an already-consumed device sequence', async () => {
    const aliceAgent = request.agent(app);
    const bobAgent = request.agent(app);
    const caraAgent = request.agent(app);
    const alice = await register(aliceAgent, 'Alice Example', 'alice');
    await register(bobAgent, 'Bob Example', 'bob');
    await register(caraAgent, 'Cara Example', 'cara');
    await aliceAgent.post('/api/offline/reserve').set('Idempotency-Key', `reserve:${randomUUID()}`).send({ amountPaise: 5000 }).expect(201);

    const pair = generateKeyPairSync('ed25519');
    const encryptionPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const deviceId = randomUUID();
    const publicKeySpki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const encryptionPublicKeySpki = encryptionPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await aliceAgent.post('/api/offline/devices').send({ deviceId, publicKeySpki, encryptionPublicKeySpki }).expect(200);
    const now = new Date();
    const firstPayload = { voucherId: randomUUID(), deviceId, sequence: 1, senderId: alice.id, offlineEpoch: 0, receiverHandle: 'bob', amountPaise: 1000, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString(), memo: '' };
    const sign = (payload) => signBytes(null, Buffer.from(canonicalJson(payload)), pair.privateKey).toString('base64');
    const firstPacket = { payload: firstPayload, signature: sign(firstPayload), publicKeySpki };
    await bobAgent.post('/api/offline/sync').send(firstPacket).expect(200);

    const secondPayload = { ...firstPayload, voucherId: randomUUID(), receiverHandle: 'cara', amountPaise: 1000 };
    const secondPacket = { payload: secondPayload, signature: sign(secondPayload), publicKeySpki };
    const replay = await caraAgent.post('/api/offline/sync').send(secondPacket).expect(409);
    expect(replay.body.error.code).toBe('REPLAY_SEQUENCE');
    const caraAfter = (await caraAgent.get('/api/wallet')).body.user;
    expect(caraAfter.balancePaise).toBe(500000);
  });

  it('revokes unsubmitted vouchers when the offline reserve is released', async () => {
    const aliceAgent = request.agent(app);
    const bobAgent = request.agent(app);
    const alice = await register(aliceAgent, 'Alice Example', 'alice');
    const bob = await register(bobAgent, 'Bob Example', 'bob');
    await aliceAgent.post('/api/offline/reserve').set('Idempotency-Key', `reserve:${randomUUID()}`).send({ amountPaise: 2000 }).expect(201);
    const pair = generateKeyPairSync('ed25519');
    const encryptionPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const deviceId = randomUUID();
    const publicKeySpki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const encryptionPublicKeySpki = encryptionPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await aliceAgent.post('/api/offline/devices').send({ deviceId, publicKeySpki, encryptionPublicKeySpki }).expect(200);
    const now = new Date();
    const payload = { voucherId: randomUUID(), deviceId, sequence: 1, senderId: alice.id, offlineEpoch: 0, receiverHandle: 'bob', amountPaise: 1000, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString(), memo: 'stale voucher' };
    const signature = signBytes(null, Buffer.from(canonicalJson(payload)), pair.privateKey).toString('base64');
    const packet = { payload, signature, publicKeySpki };

    const release = await aliceAgent.post('/api/offline/release').set('Idempotency-Key', `release:${randomUUID()}`).send({}).expect(201);
    expect(release.body.release.offlineEpoch).toBe(1);
    await aliceAgent.post('/api/offline/reserve').set('Idempotency-Key', `reserve:${randomUUID()}`).send({ amountPaise: 2000 }).expect(201);
    const rejected = await bobAgent.post('/api/offline/sync').send(packet).expect(409);
    expect(rejected.body.voucher.status).toBe('rejected');
    expect(rejected.body.voucher.rejectionCode).toBe('OFFLINE_EPOCH_REVOKED');
    const aliceAfter = (await aliceAgent.get('/api/wallet')).body.user;
    const bobAfter = (await bobAgent.get('/api/wallet')).body.user;
    expect(aliceAfter.offlineReservedPaise).toBe(2000);
    expect(bobAfter.balancePaise).toBe(bob.balancePaise);
  });

  it('rejects a tampered voucher signature', async () => {
    const aliceAgent = request.agent(app);
    const bobAgent = request.agent(app);
    const alice = await register(aliceAgent, 'Alice Example', 'alice');
    await register(bobAgent, 'Bob Example', 'bob');
    const pair = generateKeyPairSync('ed25519');
    const encryptionPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const deviceId = randomUUID();
    const publicKeySpki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const encryptionPublicKeySpki = encryptionPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await aliceAgent.post('/api/offline/devices').send({ deviceId, publicKeySpki, encryptionPublicKeySpki }).expect(200);
    const now = new Date();
    const payload = { voucherId: randomUUID(), deviceId, sequence: 1, senderId: alice.id, offlineEpoch: 0, receiverHandle: 'bob', amountPaise: 100, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString(), memo: '' };
    const validSignature = signBytes(null, Buffer.from(canonicalJson(payload)), pair.privateKey).toString('base64');
    const tamperedPayload = { ...payload, amountPaise: 200 };
    const response = await bobAgent.post('/api/offline/sync').send({ payload: tamperedPayload, signature: validSignature, publicKeySpki }).expect(400);
    expect(response.body.error.code).toBe('INVALID_SIGNATURE');
    expect(await models[4].OfflineVoucher.countDocuments({})).toBe(0);
  });
});
