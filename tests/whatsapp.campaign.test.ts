import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { setPlatform } from '../src/contracts/registry.js';
import { TemplateModel } from '../src/product/modules/whatsapp/infrastructure/whatsapp.model.js';
import { BroadcastCampaignModel } from '../src/product/modules/whatsapp/infrastructure/campaign.model.js';
import { LeadModel } from '../src/product/modules/leads/infrastructure/lead.model.js';
import { StudentModel } from '../src/product/modules/students/infrastructure/student.model.js';
import { createCampaign, executeCampaign } from '../src/product/modules/whatsapp/application/whatsapp.campaign.service.js';

let mongod: MongoMemoryServer;
const originalEnv = { ...process.env };

beforeEach(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  process.env.WHATSAPP_TOKEN = 'test-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_PROVIDER = 'generic';

  setPlatform({
    recordUsage: async () => {},
    resolveUser: async () => null,
    resolveTenant: async () => null,
    resolveDomain: async () => null,
  } as any);
});

afterEach(async () => {
  await mongoose.disconnect();
  await mongod.stop();
  process.env = { ...originalEnv };
});

describe('WhatsApp Broadcast Campaigns', () => {
  const tenantId = new mongoose.Types.ObjectId().toHexString();

  it('creates and executes broadcast campaign across leads with consent', async () => {
    // 1. Create WhatsApp template
    await TemplateModel(tenantId).create({
      name: 'btech_spot_round',
      language: 'en',
      body: 'Hello {{1}}, admissions are open for {{2}} in {{3}}!',
    });

    // 2. Create leads (one with consent, one without consent)
    const lead1 = await LeadModel(tenantId).create({
      name: 'Aditya Sharma',
      phone: '+919876543210',
      interestedCourse: 'B.Tech CSE',
      city: 'Pune',
      source: { channel: 'website' },
      consent: { given: true, source: 'website', at: new Date() },
    });

    const lead2 = await LeadModel(tenantId).create({
      name: 'Rahul Deshmukh',
      phone: '+919876543211',
      interestedCourse: 'B.Tech Mechanical',
      city: 'Mumbai',
      source: { channel: 'website' },
      consent: { given: false, source: 'website', at: new Date() },
    });

    // 3. Create campaign targeting leads
    const campaign = await createCampaign(
      { role: 'owner', tenantId, userId: 'owner-1' },
      {
        name: 'Spot Round 2026 Blast',
        template: 'btech_spot_round',
        audience: 'leads',
        paramMapping: ['name', 'course', 'city'],
      },
    );

    expect(campaign.status).toBe('draft');
    expect(campaign.template).toBe('btech_spot_round');

    // 4. Execute campaign
    const executed = await executeCampaign(tenantId, String(campaign._id), 'owner-1');

    expect(executed.status).toBe('completed');
    expect(executed.stats.total).toBe(2);
    expect(executed.stats.sent).toBe(1); // lead1 had consent
    expect(executed.stats.skippedNoConsent).toBe(1); // lead2 had no consent
  });
});
