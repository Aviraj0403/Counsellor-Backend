import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../shared/infra/logger.js';
import { buildApp } from './app.js';

const main = async () => {
  // In production create indexes deliberately (migrations), not implicitly on boot.
  mongoose.set('autoIndex', env.NODE_ENV !== 'production');
  await mongoose.connect(env.MONGO_URI, { dbName: 'cp_master', serverSelectionTimeoutMS: 10_000 });
  logger.info('database connected');

  const server = buildApp().listen(env.PORT, () => logger.info({ port: env.PORT }, 'api listening'));

  // Graceful shutdown: finish in-flight requests, then close the database.
  const stop = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
};

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
