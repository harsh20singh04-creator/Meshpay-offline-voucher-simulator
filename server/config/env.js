import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/upi_offline?replicaSet=rs0'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters').refine((value) => !value.toLowerCase().startsWith('replace-with-'), 'Replace the example JWT_SECRET with a randomly generated secret before starting the app.'),
  COOKIE_NAME: z.string().default('upi_session'),
  APP_ORIGIN: z.string().default('http://localhost:5173,http://localhost:5000'),
  JWT_TTL: z.string().default('12h'),
  DEMO_STARTING_BALANCE_PAISE: z.coerce.number().int().nonnegative().default(500000),
  MAX_TRANSFER_PAISE: z.coerce.number().int().positive().default(2000000),
  OFFLINE_VOUCHER_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(72),
});

export const env = schema.parse(process.env);
export const isProduction = env.NODE_ENV === 'production';
export const allowedOrigins = new Set(env.APP_ORIGIN.split(',').map((item) => item.trim()).filter(Boolean));
