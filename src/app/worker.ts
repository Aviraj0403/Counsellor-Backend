import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../shared/infra/logger.js';
import { startWorker } from '../shared/infra/queue.js';
import { wirePlatform } from './platform.js';
import { registerCrossModuleWiring } from './events.js';

// Wire platform adapters and cross-module pubsub
wirePlatform();
registerCrossModuleWiring();

logger.info('Starting Counsellor Platform Background Worker...');

await mongoose.connect(env.MONGO_URI, { dbName: 'cp_master' });
logger.info('Connected to MongoDB master database');

const worker = startWorker();
logger.info('BullMQ worker ready to process jobs');

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Worker shutting down gracefully');
  try {
    await worker.close();
    await mongoose.disconnect();
    logger.info('Worker cleanly stopped');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during worker shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

