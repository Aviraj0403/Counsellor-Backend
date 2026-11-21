import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { wirePlatform } from '../src/app/platform.js';
import { Tenant } from '../src/core/modules/organisations/infrastructure/tenant.model.js';
import {
  getPoptinConfig,
  savePoptinConfig,
  getPublicPoptinConfig,
  recordImpression,
  capturePoptinLead,
} from '../src/product/modules/leads/application/poptin.service.js';
import { LeadModel } from '../src/product/modules/leads/infrastructure/lead.model.js';
import { PoptinConfigModel } from '../src/product/modules/leads/infrastructure/poptin.model.js';

describe('In-House Poptin Popup Engine Tests', () => {
  let mongod: MongoMemoryServer;
  const tenantId = '00000000000000000000000a';
  const tenantSlug = 'premier-admissions';

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
    wirePlatform();

    // Create test tenant in master DB
    await Tenant.create({
      _id: new mongoose.Types.ObjectId(tenantId),
      name: 'Premier Admissions',
      slug: tenantSlug,
      status: 'active',
    });
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  it('manages tenant poptin configuration and default values', async () => {
    // Initially gets default
    const config = await getPoptinConfig(tenantId);
    expect(config.enabled).toBe(false);
    expect(config.headline).toContain('B.Tech');

    // Update config
    const updated = await savePoptinConfig(tenantId, {
      enabled: true,
      headline: 'Direct Admission Open 2026',
      allowedDomains: ['mycollegeportal.com'],
      triggers: {
        exitIntent: true,
        timeDelaySeconds: 10,
        scrollPercentage: 50,
      },
    });

    expect(updated.enabled).toBe(true);
    expect(updated.headline).toBe('Direct Admission Open 2026');
    expect(updated.allowedDomains).toEqual(['mycollegeportal.com']);
  });

  it('serves public config with domain whitelist verification', async () => {
    await savePoptinConfig(tenantId, {
      enabled: true,
      headline: 'Special Cutoff Consultation',
      allowedDomains: ['admissions.org'],
    });

    // Request from unauthorized origin -> blocked (returns null)
    const unauthorized = await getPublicPoptinConfig(tenantSlug, 'https://hacker.com');
    expect(unauthorized).toBeNull();

    // Request from authorized origin -> allowed
    const authorized = await getPublicPoptinConfig(tenantSlug, 'https://admissions.org');
    expect(authorized).toBeDefined();
    expect(authorized?.headline).toBe('Special Cutoff Consultation');
  });

  it('tracks popup impressions and captures leads directly into CRM with metrics update', async () => {
    await savePoptinConfig(tenantId, {
      enabled: true,
      headline: 'Instant Scholarship Guidance',
    });

    // 1. Impression view
    await recordImpression(tenantSlug);
    let currentConfig = await getPoptinConfig(tenantId);
    expect(currentConfig.viewsCount).toBe(1);

    // 2. Submit lead enquiry from popup
    const submission = await capturePoptinLead(tenantSlug, {
      name: 'Aman Patel',
      phone: '9876543210',
      email: 'aman@example.com',
      city: 'Pune',
      interestedCourse: 'Computer Science',
      sourceUrl: 'https://admissions.org/btech-direct',
    });

    expect(submission.leadId).toBeDefined();
    expect(submission.duplicate).toBe(false);

    // 3. Verify lead stored in CRM tenant DB
    const lead = await LeadModel(tenantId).findById(submission.leadId);
    expect(lead).toBeDefined();
    expect(lead?.name).toBe('Aman Patel');
    expect(lead?.phone).toBe('+919876543210');
    expect(lead?.source?.utmSource).toBe('poptin_popup');

    // 4. Verify conversion metric incremented
    currentConfig = await getPoptinConfig(tenantId);
    expect(currentConfig.conversionsCount).toBe(1);
  });
});

