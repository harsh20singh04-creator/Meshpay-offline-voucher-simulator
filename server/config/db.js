import mongoose from 'mongoose';
import { env } from './env.js';

mongoose.set('strictQuery', true);
// Request values are validated and mapped into explicit query fields; never pass raw request filters to Mongoose.

export async function connectDatabase(uri = env.MONGODB_URI) {
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 20,
    minPoolSize: 1,
    autoIndex: true,
  });
  // Wait for model indexes before accepting requests (idempotency relies on unique indexes).
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    await mongoose.disconnect();
    throw new Error('MongoDB must run as a replica set or sharded cluster; standalone MongoDB does not support the multi-document transactions used by MeshPay.');
  }

  const models = Object.values(mongoose.models);
  await Promise.all(models.map((model) => model.init()));
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
