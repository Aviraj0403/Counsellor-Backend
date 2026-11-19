import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { hashPassword } from '../src/core/modules/identity/infrastructure/security.js';
import { User } from '../src/core/modules/identity/infrastructure/user.model.js';

/** One-time: creates the first Super Admin from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD. Safe to re-run. */
const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD;
if (!email || !password || password.length < 10) {
  console.error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (min 10 characters) in .env first.');
  process.exit(1);
}

await mongoose.connect(env.MONGO_URI, { dbName: 'cp_master' });
if (await User.exists({ email })) {
  console.log(`Super Admin ${email} already exists. Nothing to do.`);
} else {
  await User.create({ email, name: 'Super Admin', passwordHash: await hashPassword(password), role: 'superadmin', tenantId: null });
  console.log(`Super Admin ${email} created. Remove SEED_ADMIN_PASSWORD from .env now.`);
}
await mongoose.disconnect();
