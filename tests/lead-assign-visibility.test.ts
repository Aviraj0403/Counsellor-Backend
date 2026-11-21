import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { wirePlatform } from '../src/app/platform.js';
import { systemPrincipal } from '../src/contracts/system.js';
import type { Principal } from '../src/contracts/port.js';
import { createLead, listLeads } from '../src/product/modules/leads/application/lead.service.js';
import { LeadModel } from '../src/product/modules/leads/infrastructure/lead.model.js';
import { createStudent, listStudents, getStudentForPrincipal } from '../src/product/modules/students/application/student.service.js';
import { StudentModel } from '../src/product/modules/students/infrastructure/student.model.js';
import { Tenant } from '../src/core/modules/organisations/infrastructure/tenant.model.js';
import { updateTenantProfile } from '../src/core/modules/organisations/application/organisations.service.js';

describe('Auto-Assignment & Counsellor Visibility Tests', () => {
  let mongod: MongoMemoryServer;
  const tenantId = '00000000000000000000000a';
  const counsellor1 = '0000000000000000000000c1';
  const counsellor2 = '0000000000000000000000c2';

  const counsellorPrincipal1: Principal = {
    userId: counsellor1,
    email: 'c1@test.com',
    name: 'Counsellor One',
    role: 'counsellor',
    scope: 'tenant',
    tenantId,
    permissions: ['leads:read', 'students:read', 'students:write'],
  };

  const counsellorPrincipal2: Principal = {
    userId: counsellor2,
    email: 'c2@test.com',
    name: 'Counsellor Two',
    role: 'counsellor',
    scope: 'tenant',
    tenantId,
    permissions: ['leads:read', 'students:read', 'students:write'],
  };

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri(), { dbName: 'cp_master' });
    wirePlatform();

    // Create tenant in master DB
    await Tenant.create({
      _id: new mongoose.Types.ObjectId(tenantId),
      name: 'Admissions Agency',
      slug: 'admissions-agency',
      status: 'active',
      settings: {
        counsellorAllStudentsVisible: true,
      },
    });
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  describe('Lead Round-Robin Auto-Assignment', () => {
    it('automatically assigns incoming public/system leads across counsellors', async () => {
      // Mock listTeam to return 2 active counsellors
      const { setPlatform, getPlatform } = await import('../src/contracts/registry.js');
      const realPlatform = getPlatform();
      setPlatform({
        ...realPlatform,
        listTeam: async () => [
          { id: counsellor1, name: 'Counsellor One', role: 'counsellor' },
          { id: counsellor2, name: 'Counsellor Two', role: 'counsellor' },
        ],
      });

      // 1st lead from system (e.g. meta ads)
      const lead1 = await createLead(systemPrincipal(tenantId, 'meta-ads'), {
        name: 'Student 1',
        phone: '9876543210',
        source: { channel: 'meta_ads' },
        consent: { given: true },
      });

      expect(lead1.lead.assignedTo).toBe(counsellor1);

      // 2nd lead from system should balance to counsellor2 (least loaded)
      const lead2 = await createLead(systemPrincipal(tenantId, 'meta-ads'), {
        name: 'Student 2',
        phone: '9876543211',
        source: { channel: 'meta_ads' },
        consent: { given: true },
      });

      expect(lead2.lead.assignedTo).toBe(counsellor2);

      // 3rd lead should balance back to counsellor1 (or tie break)
      const lead3 = await createLead(systemPrincipal(tenantId, 'meta-ads'), {
        name: 'Student 3',
        phone: '9876543212',
        source: { channel: 'meta_ads' },
        consent: { given: true },
      });

      expect(lead3.lead.assignedTo).toBe(counsellor1);
    });
  });

  describe('Configurable Counsellor Student Visibility', () => {
    it('allows counsellor to view all organisation students when counsellorAllStudentsVisible is true', async () => {
      // Create student assigned to counsellor 2
      const student = await createStudent(counsellorPrincipal2, {
        name: 'Rahul Sharma',
        phone: '9998887771',
        consent: { given: true },
        assignedTo: counsellor2,
      });

      // Counsellor 1 lists students
      const list = await listStudents(counsellorPrincipal1, { page: 1, limit: 10 });
      expect(list.total).toBe(1);
      expect(list.items[0]._id.toString()).toBe(student._id.toString());

      // Counsellor 1 can also retrieve student details
      const detail = await getStudentForPrincipal(counsellorPrincipal1, String(student._id));
      expect(detail.name).toBe('Rahul Sharma');
    });

    it('restricts counsellor when organisation owner disables counsellorAllStudentsVisible', async () => {
      // Update tenant setting to restrict visibility
      await updateTenantProfile(tenantId, {
        settings: { counsellorAllStudentsVisible: false },
      });

      // Create student assigned to counsellor 2
      const student = await createStudent(counsellorPrincipal2, {
        name: 'Priya Verma',
        phone: '9998887772',
        consent: { given: true },
        assignedTo: counsellor2,
      });

      // Counsellor 1 lists students -> should see 0 (not assigned to them)
      const listC1 = await listStudents(counsellorPrincipal1, { page: 1, limit: 10 });
      expect(listC1.total).toBe(0);

      // Counsellor 2 lists students -> should see 1 (assigned to them)
      const listC2 = await listStudents(counsellorPrincipal2, { page: 1, limit: 10 });
      expect(listC2.total).toBe(1);

      // Counsellor 1 accessing directly throws 404
      await expect(getStudentForPrincipal(counsellorPrincipal1, String(student._id))).rejects.toThrow('Student');
    });
  });
});

