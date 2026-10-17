import 'dotenv/config';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { env } from './config/env.js';

let server;

async function start() {
  await connectDatabase();
  const app = createApp();
  server = app.listen(env.PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({ level: 'info', event: 'server_started', port: env.PORT, environment: env.NODE_ENV }));
  });
}

async function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }));
  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDatabase();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((error) => {
  console.error(JSON.stringify({ level: 'fatal', event: 'startup_failed', message: error.message }));
  process.exit(1);
});
