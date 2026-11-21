import type { Principal } from '../../../../contracts/port.js';
import { notFound, badRequest } from '../../../../shared/kernel/errors.js';
import { audit } from '../../audit/index.js';
import { BatchModel, SessionModel, type AttendanceStatus, type BatchStatus } from '../infrastructure/batch.model.js';
import { StudentModel } from '../infrastructure/student.model.js';

export interface CreateBatchInput {
  name: string;
  academicYear: string;
  courseStream?: string;
  counsellorId?: string;
  capacity?: number;
  startDate?: Date;
  endDate?: Date;
  notes?: string;
}

export const listBatches = async (tenantId: string, filter: { academicYear?: string; status?: BatchStatus }) => {
  const q: any = {};
  if (filter.academicYear) q.academicYear = filter.academicYear;
  if (filter.status) q.status = filter.status;
  return BatchModel(tenantId).find(q).sort({ createdAt: -1 }).lean();
};

export const getBatch = async (tenantId: string, batchId: string) => {
  const batch = await BatchModel(tenantId).findById(batchId).lean<any>();
  if (!batch) throw notFound('Batch');

  // Populate student details
  const students = await StudentModel(tenantId)
    .find({ _id: { $in: batch.studentIds || [] } })
    .select('_id name phone email status')
    .lean();

  return { ...batch, students };
};

export const createBatch = async (p: Principal, input: CreateBatchInput) => {
  const tenantId = p.tenantId!;
  const doc = await BatchModel(tenantId).create({
    ...input,
    createdBy: p.userId,
  });

  await audit(tenantId, {
    action: 'batch.created',
    entity: 'student_batch',
    entityId: String(doc._id),
    meta: { name: doc.name, academicYear: doc.academicYear },
  });

  return doc.toObject();
};

export const addStudentsToBatch = async (tenantId: string, batchId: string, studentIds: string[], userId: string) => {
  const Batch = BatchModel(tenantId);
  const batch = await Batch.findById(batchId);
  if (!batch) throw notFound('Batch');

  const existingSet = new Set(batch.studentIds || []);
  for (const id of studentIds) {
    existingSet.add(id);
  }

  batch.studentIds = Array.from(existingSet);
  await batch.save();

  await audit(tenantId, {
    action: 'batch.students_enrolled',
    entity: 'student_batch',
    entityId: batchId,
    meta: { addedCount: studentIds.length, total: batch.studentIds.length, by: userId },
  });

  return batch.toObject();
};

export const removeStudentFromBatch = async (tenantId: string, batchId: string, studentId: string, userId: string) => {
  const Batch = BatchModel(tenantId);
  const batch = await Batch.findById(batchId);
  if (!batch) throw notFound('Batch');

  batch.studentIds = (batch.studentIds || []).filter((id: string) => id !== studentId);
  await batch.save();

  await audit(tenantId, {
    action: 'batch.student_removed',
    entity: 'student_batch',
    entityId: batchId,
    meta: { studentId, by: userId },
  });

  return batch.toObject();
};

// Sessions & Attendance
export interface CreateSessionInput {
  batchId: string;
  title: string;
  description?: string;
  sessionDate: Date;
  startTime: string;
  endTime: string;
  venue?: string;
}

export const listSessions = async (tenantId: string, batchId: string) => {
  return SessionModel(tenantId).find({ batchId }).sort({ sessionDate: 1 }).lean();
};

export const createSession = async (p: Principal, input: CreateSessionInput) => {
  const tenantId = p.tenantId!;
  const batch = await BatchModel(tenantId).findById(input.batchId);
  if (!batch) throw notFound('Batch');

  const doc = await SessionModel(tenantId).create({
    ...input,
    mentorId: batch.counsellorId || p.userId,
    createdBy: p.userId,
  });

  await audit(tenantId, {
    action: 'session.created',
    entity: 'batch_session',
    entityId: String(doc._id),
    meta: { batchId: input.batchId, title: doc.title },
  });

  return doc.toObject();
};

export const markAttendance = async (
  tenantId: string,
  sessionId: string,
  records: { studentId: string; status: AttendanceStatus; notes?: string }[],
  userId: string,
) => {
  const Session = SessionModel(tenantId);
  const session = await Session.findById(sessionId);
  if (!session) throw notFound('Session');

  const attendanceMap = new Map((session.attendance || []).map((a: any) => [a.studentId, a]));
  for (const r of records) {
    attendanceMap.set(r.studentId, {
      studentId: r.studentId,
      status: r.status,
      markedAt: new Date(),
      notes: r.notes,
    });
  }

  session.attendance = Array.from(attendanceMap.values());
  session.status = 'completed';
  await session.save();

  await audit(tenantId, {
    action: 'session.attendance_marked',
    entity: 'batch_session',
    entityId: sessionId,
    meta: { markedCount: records.length, by: userId },
  });

  return session.toObject();
};

