import { Queue, Worker, type Job, type RedisOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { logger } from './logger.js';

export interface WhatsAppJobData {
  type: 'whatsapp:send';
  tenantId: string;
  messageId: string;
}

export interface WebhookRetryJobData {
  type: 'webhook:retry';
  tenantId: string;
  deliveryId: string;
}

export type BackgroundJobData = WhatsAppJobData | WebhookRetryJobData;

export interface JobEnqueueOptions {
  delayMs?: number;
  attempts?: number;
}

export interface JobQueue {
  enqueue(data: BackgroundJobData, opts?: JobEnqueueOptions): Promise<string>;
  close(): Promise<void>;
}

// In-Memory Fallback Queue (when Redis is not configured in local/test environments)
class MemoryJobQueue implements JobQueue {
  private timers = new Set<NodeJS.Timeout>();

  async enqueue(data: BackgroundJobData, opts?: JobEnqueueOptions): Promise<string> {
    const jobId = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const delay = opts?.delayMs ?? 0;

    const run = async () => {
      try {
        await processJob(data);
      } catch (err: any) {
        logger.error({ err: err?.message, jobId, type: data.type, tenantId: data.tenantId }, 'Memory job execution failed');
      }
    };

    if (delay > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        run();
      }, delay);
      this.timers.add(timer);
    } else {
      setImmediate(run);
    }

    return jobId;
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

// BullMQ Persistent Redis Queue
class BullMQJobQueue implements JobQueue {
  private queue: Queue<BackgroundJobData>;
  private connection: Redis;

  constructor(redisUrl: string) {
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    this.queue = new Queue<BackgroundJobData>('counsellor_jobs', { connection: this.connection as any });
  }

  async enqueue(data: BackgroundJobData, opts?: JobEnqueueOptions): Promise<string> {
    const job = await this.queue.add(data.type, data, {
      delay: opts?.delayMs ?? 0,
      attempts: opts?.attempts ?? 5,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    });
    return String(job.id);
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}

let activeQueue: JobQueue | null = null;

export const getJobQueue = (): JobQueue => {
  if (activeQueue) return activeQueue;
  if (env.REDIS_URL) {
    try {
      activeQueue = new BullMQJobQueue(env.REDIS_URL);
      logger.info({ redisUrl: env.REDIS_URL.replace(/:[^:@]+@/, ':***@') }, 'BullMQ Redis job queue initialized');
    } catch (err) {
      logger.warn({ err }, 'Could not connect to Redis, falling back to memory queue');
      activeQueue = new MemoryJobQueue();
    }
  } else {
    activeQueue = new MemoryJobQueue();
  }
  return activeQueue;
};

export const setJobQueue = (q: JobQueue | null): void => {
  activeQueue = q;
};

/**
 * Dedicated job processor. Preserves tenant isolation by executing in tenant database context.
 */
export const processJob = async (data: BackgroundJobData): Promise<void> => {
  const { tenantId, type } = data;
  logger.info({ type, tenantId }, 'Processing background job');

  if (type === 'whatsapp:send') {
    const { deliver } = await import('../../product/modules/whatsapp/application/whatsapp.service.js');
    await deliver(tenantId, data.messageId);
  } else if (type === 'webhook:retry') {
    const { WebhookDeliveryModel } = await import('../../product/modules/publicApi/infrastructure/publicApi.model.js');
    const { attemptDelivery } = await import('../../product/modules/publicApi/application/webhook.service.js');
    const delivery = await WebhookDeliveryModel(tenantId).findById(data.deliveryId).lean();
    if (delivery && delivery.status === 'retrying') {
      await attemptDelivery(tenantId, delivery);
    }
  } else {
    logger.warn({ data }, 'Unknown job type received');
  }
};

/**
 * Starts a BullMQ worker listener. Run in a dedicated worker process (`npm run worker`).
 */
export const startWorker = (redisUrl = env.REDIS_URL): { close(): Promise<void> } => {
  if (!redisUrl) {
    logger.warn('REDIS_URL not set; BullMQ worker process is idling on memory fallback.');
    return { close: async () => {} };
  }

  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker<BackgroundJobData>(
    'counsellor_jobs',
    async (job: Job<BackgroundJobData>) => {
      await processJob(job.data);
    },
    { connection: connection as any, concurrency: 5 },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, type: job.data.type, tenantId: job.data.tenantId }, 'Job completed successfully');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, type: job?.data.type, tenantId: job?.data.tenantId, err: err.message }, 'Job failed');
  });

  return {
    close: async () => {
      await worker.close();
      await connection.quit();
    },
  };
};

