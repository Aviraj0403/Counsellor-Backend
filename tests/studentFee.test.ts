import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { setPlatform } from '../src/contracts/registry.js';
import { StudentModel } from '../src/product/modules/students/infrastructure/student.model.js';
import { ApplicationModel } from '../src/product/modules/applications/infrastructure/application.model.js';
import { StudentFeeLinkModel } from '../src/product/modules/applications/infrastructure/feeLink.model.js';
import {
  createStudentFeeLink,
  markStudentFeePaid,
} from '../src/product/modules/applications/application/studentFee.service.js';

let mongod: MongoMemoryServer;

beforeEach(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

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
});

describe('Student Fee Links and Online Payments', () => {
  const tenantId = new mongoose.Types.ObjectId().toHexString();

  it('creates Razorpay student payment link and handles status transition to paid', async () => {
    // 1. Create student and application
    const student = await StudentModel(tenantId).create({
      name: 'Aditya Birla',
      phone: '+919876543201',
      email: 'aditya@example.com',
      status: 'active',
      consent: { given: true },
    });

    const app = await ApplicationModel(tenantId).create({
      studentId: String(student._id),
      collegeId: new mongoose.Types.ObjectId().toHexString(),
      courseId: new mongoose.Types.ObjectId().toHexString(),
      intake: { month: 8, year: 2026 },
      fee: { applicationFeePaise: 500000, tuitionPaise: 15000000, paidPaise: 0 },
    });

    // 2. Generate fee link for seat booking
    const link = await createStudentFeeLink(
      { role: 'counsellor', tenantId, userId: 'counsellor-1' } as any,
      {
        studentId: String(student._id),
        applicationId: String(app._id),
        title: 'Seat Booking Token Advance',
        amountRupees: 25000,
        notes: 'COEP Seat Reservation',
      },
    );

    expect(link.title).toBe('Seat Booking Token Advance');
    expect(link.amountPaise).toBe(2500000);
    expect(link.status).toBe('created');
    expect(link.shortUrl).toBeDefined();

    // 3. Mark link paid (webhook simulation)
    const paid = await markStudentFeePaid(tenantId, String(link._id), { paymentId: 'pay_rzp_123456' }, 'system:webhook');
    expect(paid.status).toBe('paid');
    expect(paid.paymentId).toBe('pay_rzp_123456');

    // 4. Verify application paid amount incremented
    const updatedApp = await ApplicationModel(tenantId).findById(app._id).lean<any>();
    expect(updatedApp.fee.paidPaise).toBe(2500000);
  });
});

