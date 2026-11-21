import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { setPlatform } from '../src/contracts/registry.js';
import { StudentModel } from '../src/product/modules/students/infrastructure/student.model.js';
import { ReferralModel, ReferralProgramModel } from '../src/product/modules/leads/infrastructure/referral.model.js';
import { getOrCreateStudentReferralCode, recordReferralLead, updateReferralStatus } from '../src/product/modules/leads/application/referral.service.js';

let mongod: MongoMemoryServer;

beforeEach(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  setPlatform({
    recordUsage: async () => {},
    resolveUser: async () => null,
    resolveTenant: async () => null,
    resolveDomain: async () => null,
    listTeam: async () => [],
  } as any);
});

afterEach(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('Student Referral Program', () => {
  const tenantId = new mongoose.Types.ObjectId().toHexString();

  it('generates referral code and captures leads attributed to referrer student', async () => {
    // 1. Create a student who will be referring
    const student = await StudentModel(tenantId).create({
      name: 'Rohan Patil',
      phone: '+919988776655',
      status: 'active',
      consent: { given: true },
    });

    // 2. Generate referral code
    const refInfo = await getOrCreateStudentReferralCode(tenantId, String(student._id));
    expect(refInfo.referralCode).toBeDefined();
    expect(refInfo.studentName).toBe('Rohan Patil');

    // 3. Record new lead referred via this code
    const recorded = await recordReferralLead(tenantId, {
      id: new mongoose.Types.ObjectId().toHexString(),
      name: 'Amit Joshi',
      phone: '+919922334455',
      referralCode: refInfo.referralCode,
    });

    expect(recorded).not.toBeNull();
    expect(recorded?.referrerStudentId).toBe(String(student._id));
    expect(recorded?.status).toBe('pending');
    expect(recorded?.rewardAmountRupees).toBe(2000);

    // 4. Update status when student enrolls and gets rewarded
    const updated = await updateReferralStatus(tenantId, String(recorded?._id), 'rewarded', 'Admission confirmed in COEP');
    expect(updated.status).toBe('rewarded');
    expect(updated.rewardedAt).toBeDefined();
  });
});

