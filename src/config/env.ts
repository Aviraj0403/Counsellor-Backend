import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL: z.string().default('1h'),
  CORS_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.string().default('info'),
  PLATFORM_MODE: z.enum(['local', 'remote']).default('local'),
  /** login attempts allowed per IP per 15 minutes */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  // ---- access and refresh tokens
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),

  // ---- file vault (documents) and encrypted settings (integration tokens)
  /** 64 hex chars (32 bytes). Required to store documents or integration secrets. Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" */
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters').optional(),
  FILE_STORAGE_DIR: z.string().default('./storage'),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().max(25).default(10),
  /** how long a signed download link stays valid, in seconds */
  DOWNLOAD_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(120),

  /** public address of this API, used in webhook URLs and public pages (no trailing slash) */
  PUBLIC_BASE_URL: z.string().default('http://localhost:4100'),

  // ---- Meta (lead ads webhook + Conversions API). Platform-level app; each organisation adds its own pixel/page tokens.
  META_GRAPH_VERSION: z.string().default('v21.0'),
  META_APP_SECRET: z.string().optional(),

  // ---- WhatsApp Cloud API (one platform number shared by organisations, preferred) and what each message costs us
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_COST_PER_MESSAGE_PAISE: z.coerce.number().int().min(0).default(80),

  // ---- Razorpay (payment links for invoices)
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

/** Validates env once at boot: the app refuses to start with a bad config instead of failing later. */
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  return parsed.data;
};

export const env: Env = loadEnv();
