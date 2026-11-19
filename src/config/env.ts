import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL: z.string().default('1h'),
  /** Our own web apps (admin console, portals). Comma list of full https origins. Always allowed; more can be added from the superadmin console. */
  PLATFORM_ORIGINS: z.string().default('https://counsellor.jdinfotechsolutions.in'),
  /** Extra origins from config (for example local development): http://localhost:5173 */
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

  // ---- AI admissions assistant (module aiBot). The key is optional: without it the bot reports itself offline.
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Claude model id. Default claude-opus-5-5; the owner can set claude-haiku-5-5 for lower cost. */
  AI_MODEL: z.string().default('claude-opus-5-5'),
  /** Used to turn USD token prices into paise when metering AI cost */
  AI_INR_PER_USD: z.coerce.number().positive().default(90),
  /** Secret for the signed WhatsApp-inbound endpoint of the bot (HMAC-SHA256 of the raw body). Unset = endpoint refuses. */
  BOT_INBOUND_SECRET: z.string().optional(),

  // ---- Razorpay (payment links for invoices)
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  /** Shared secret for platform job endpoints (cron/pm2 calls POST /public/appointments/jobs/run-reminders with header x-jobs-secret). Unset or shorter than 16 characters = job endpoints refuse. */
  JOBS_SECRET: z.string().optional(),
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
