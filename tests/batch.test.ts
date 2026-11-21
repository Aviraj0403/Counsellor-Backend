import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { setPlatform } from '../src/contracts/registry.js';
import { StudentModel } from '../src/product/modules/students/infrastructure/student.model.js';
import { BatchModel, SessionModel } from '../src/product/modules/students/infrastructure/batch.model.js';
import {
  createBatch,
  addStudentsToBatch,
  createSession,
  markAttendance,
} from '../src/product/modules/students/application/batch.service.js';

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

describe('Batches, Sessions and Attendance Management', () => {
  const tenantId = new mongoose.Types.ObjectId().toHexString();

  it('creates batch cohort, adds students, schedules session, and records attendance', async () => {
    // 1. Create student
    const student = await StudentModel(tenantId).create({
      name: 'Pooja Kulkarni',
      phone: '+919876543299',
      status: 'active',
      consent: { given: true },
    });

    // 2. Create batch
    const batch = await createBatch(
      { role: 'counsellor', tenantId, userId: 'counsellor-1' } as any,
      {
        name: '2026 Maharashtra State Cap Round 1',
        academicYear: '2026-2027',
        courseStream: 'B.Tech Engineering',
        capacity: 40,
      },
    );

    expect(batch.name).toBe('2026 Maharashtra State Cap Round 1');
    expect(batch.status).toBe('active');

    // 3. Add student to batch
    const updatedBatch = await addStudentsToBatch(tenantId, String(batch._id), [String(student._id)], 'counsellor-1');
    expect(updatedBatch.studentIds).toContain(String(student._id));

    // 4. Schedule a counselling session
    const session = await createSession(
      { role: 'counsellor', tenantId, userId: 'counsellor-1' } as any,
      {
        batchId: String(batch._id),
        title: 'College Preference Selection Strategy',
        sessionDate: new Date('2026-11-25T10:00:00Z'),
        startTime: '10:00 AM',
        endTime: '11:30 AM',
        venue: 'Zoom Room 1',
      },
    );

    expect(session.title).toBe('College Preference Selection Strategy');
    expect(session.status).toBe('scheduled');

    // 5. Mark student attendance
    const attended = await markAttendance(
      tenantId,
      String(session._id),
      [{ studentId: String(student._id), status: 'present', notes: 'Participated actively' }],
      'counsellor-1',
    );

    expect(attended.status).toBe('completed');
    expect(attended.attendance.length).toBe(1);
    expect(attended.attendance[0].status).toBe('present');
    expect(attended.attendance[0].studentId).toBe(String(student._id));
  });
});

