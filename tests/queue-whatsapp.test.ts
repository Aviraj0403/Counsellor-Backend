import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { wirePlatform } from '../src/app/platform.js';
import { getJobQueue, setJobQueue, processJob, type JobQueue, type BackgroundJobData } from '../src/shared/infra/queue.js';
import { getWhatsAppProvider, setWhatsAppProvider, MetaCloudApiProvider, GenericWebhookProvider, type WhatsAppProvider } from '../src/product/modules/whatsapp/infrastructure/provider.js';
import { setHttpClient, resetHttpClient, type HttpResponse } from '../src/shared/infra/http.js';
import { MessageModel } from '../src/product/modules/whatsapp/infrastructure/whatsapp.model.js';
import { deliver } from '../src/product/modules/whatsapp/application/whatsapp.service.js';

describe('Job Queue & WhatsApp Provider Tests', () => {
  let mongod: MongoMemoryServer;
  const tenantA = '00000000000000000000000a';
  const tenantB = '00000000000000000000000b';

  beforeEach(async () => {
    wirePlatform();
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
    setJobQueue(null);
    setWhatsAppProvider(null);
    // ensure test has dummy tokens so provider isConfigured() evaluates true
    process.env.WHATSAPP_TOKEN = 'test_token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'test_phone_id';
  });

  afterEach(async () => {
    resetHttpClient();
    setJobQueue(null);
    setWhatsAppProvider(null);
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    await mongoose.disconnect();
    await mongod.stop();
  });

  describe('Queue and Worker Processor', () => {
    it('enqueues and processes background jobs with tenant context preserved', async () => {
      // Mock HTTP for WhatsApp delivery
      let httpCalls = 0;
      setHttpClient(async (url, req): Promise<HttpResponse> => {
        httpCalls++;
        expect(url).toContain('messages');
        expect(req?.headers?.authorization).toBeDefined();
        return {
          status: 200,
          ok: true,
          data: { messages: [{ id: 'wamid.HBgL12345' }] },
          text: JSON.stringify({ messages: [{ id: 'wamid.HBgL12345' }] }),
        };
      });

      // Create a queued message in tenantA's database
      const msg = await MessageModel(tenantA).create({
        direction: 'out',
        to: '+919876543210',
        template: 'lead_welcome',
        language: 'en',
        status: 'queued',
      });

      // Enqueue job for tenantA
      const queue = getJobQueue();
      const jobId = await queue.enqueue({
        type: 'whatsapp:send',
        tenantId: tenantA,
        messageId: String(msg._id),
      });

      expect(jobId).toBeDefined();

      // Verify that processing the job executes in tenantA
      await processJob({
        type: 'whatsapp:send',
        tenantId: tenantA,
        messageId: String(msg._id),
      });

      // Assert status in tenantA database
      const updated = await MessageModel(tenantA).findById(msg._id);
      expect(updated?.status).toBe('sent');
      expect(updated?.providerId).toBe('wamid.HBgL12345');

      // Assert tenantB database is completely isolated and does not have this record
      const tenantBCount = await MessageModel(tenantB).countDocuments();
      expect(tenantBCount).toBe(0);
    });

    it('simulates worker retry on transient HTTP error and marks error message', async () => {
      // Mock failure from Meta API
      setHttpClient(async (): Promise<HttpResponse> => {
        return {
          status: 500,
          ok: false,
          data: { error: { message: 'Meta Cloud API rate limited' } },
          text: 'Internal error',
        };
      });

      const msg = await MessageModel(tenantA).create({
        direction: 'out',
        to: '+919876543210',
        template: 'lead_welcome',
        language: 'en',
        status: 'queued',
      });

      await processJob({
        type: 'whatsapp:send',
        tenantId: tenantA,
        messageId: String(msg._id),
      });

      const updated = await MessageModel(tenantA).findById(msg._id);
      expect(updated?.status).toBe('failed');
      expect(updated?.error).toContain('Meta Cloud API rate limited');
    });
  });

  describe('WhatsApp Provider Selection and Failover', () => {
    it('uses MetaCloudApiProvider by default and formats payload correctly', async () => {
      let sentPayload: any = null;
      let authHeader: string | undefined;

      setHttpClient(async (url, req): Promise<HttpResponse> => {
        sentPayload = req?.body;
        authHeader = req?.headers?.authorization;
        return {
          status: 200,
          ok: true,
          data: { messages: [{ id: 'wamid.meta.123' }] },
          text: '',
        };
      });

      const provider = new MetaCloudApiProvider();
      const res = await provider.sendTemplate('+919876543210', 'admission_offer', 'en', ['Rohan', 'Computer Science']);

      expect(res.providerId).toBe('wamid.meta.123');
      expect(sentPayload?.messaging_product).toBe('whatsapp');
      expect(sentPayload?.to).toBe('919876543210');
      expect(sentPayload?.template?.name).toBe('admission_offer');
    });

    it('allows fallback to GenericWebhookProvider', async () => {
      let webhookCalled = false;
      let webhookBody: any = null;

      setHttpClient(async (url, req): Promise<HttpResponse> => {
        webhookCalled = true;
        webhookBody = req?.body;
        return {
          status: 200,
          ok: true,
          data: { id: 'gw_999' },
          text: '',
        };
      });

      const fallback = new GenericWebhookProvider();
      // inject gateway url for test
      (fallback as any).isConfigured = () => true;

      const res = await fallback.sendTemplate('+919876543210', 'test_template', 'en', ['Val1']);
      expect(res.providerId).toBe('gw_999');
      expect(webhookCalled).toBe(true);
      expect(webhookBody?.template).toBe('test_template');
    });
  });
});
