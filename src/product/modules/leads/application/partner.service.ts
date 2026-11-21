import { PartnerDirectoryModel } from '../infrastructure/partner.model.js';
import { notFound } from '../../../../shared/kernel/errors.js';

export interface PartnerQuery {
  city?: string;
  type?: string;
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export const listPartners = async (tenantId: string, q: PartnerQuery) => {
  const Model = PartnerDirectoryModel(tenantId);
  const filter: Record<string, any> = {};
  if (q.city) filter.city = new RegExp(`^${q.city.trim()}$`, 'i');
  if (q.type) filter.type = q.type;
  if (q.status) filter.status = q.status;
  if (q.search) {
    const s = q.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ name: new RegExp(s, 'i') }, { contactPerson: new RegExp(s, 'i') }, { phone: new RegExp(s, 'i') }];
  }

  const page = q.page || 1;
  const limit = q.limit || 20;

  const [items, total] = await Promise.all([
    Model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Model.countDocuments(filter),
  ]);

  return { items, total, page, limit };
};

export const addPartner = async (tenantId: string, body: any) => {
  const Model = PartnerDirectoryModel(tenantId);
  const partner = await Model.create(body);
  return partner.toObject();
};

export const updatePartnerStatus = async (tenantId: string, id: string, status: string, notes?: string) => {
  const Model = PartnerDirectoryModel(tenantId);
  const partner = await Model.findByIdAndUpdate(
    id,
    { status, ...(notes ? { notes } : {}), lastOutreachAt: new Date() },
    { new: true }
  ).lean<any>();
  if (!partner) throw notFound('Partner');
  return partner;
};

// Seed realistic coaching institutes & schools for key cities if empty
export const ensureInitialPartners = async (tenantId: string) => {
  const Model = PartnerDirectoryModel(tenantId);
  const count = await Model.countDocuments();
  if (count > 0) return;

  const samplePartners = [
    {
      name: 'Allen Career Institute - Pune Camp Centre',
      type: 'coaching_institute',
      city: 'Pune',
      state: 'Maharashtra',
      address: 'Kumar Prestige Point, Bajirao Road, Shukrawar Peth, Pune',
      phone: '+912067062000',
      contactPerson: 'Manoj Sharma',
      designation: 'Center Manager',
      estStudentsCount: 650,
      status: 'contacted',
      notes: 'Interested in seminar for 12th repeaters on engineering cutoffs.',
    },
    {
      name: 'FIITJEE Pune Center',
      type: 'coaching_institute',
      city: 'Pune',
      state: 'Maharashtra',
      address: 'Lloyds Chambers, Maldhakka Chowk, Pune',
      phone: '+912041418686',
      contactPerson: 'Suresh Iyer',
      designation: 'Academic Coordinator',
      estStudentsCount: 420,
      status: 'identified',
      notes: 'Target for JEE Counselling session collaboration.',
    },
    {
      name: 'Fergusson Junior College of Science',
      type: 'junior_college',
      city: 'Pune',
      state: 'Maharashtra',
      address: 'FC Road, Shivajinagar, Pune',
      phone: '+912067656000',
      contactPerson: 'Dr. Anita Joshi',
      designation: 'Vice Principal (Science)',
      estStudentsCount: 1200,
      status: 'meeting_scheduled',
      notes: 'Meeting on Friday regarding Career Guidance Day.',
    },
    {
      name: 'Resonance Eduventures - Kothrud',
      type: 'coaching_institute',
      city: 'Pune',
      state: 'Maharashtra',
      address: 'Mayur Colony, Kothrud, Pune',
      phone: '+912025458900',
      contactPerson: 'Vikram Patil',
      designation: 'Branch Head',
      estStudentsCount: 310,
      status: 'partnered',
      notes: 'Active partner. Shared 150 student enquiry sheet.',
    },
    {
      name: 'PACE IIT & Medical - Dadar Centre',
      type: 'coaching_institute',
      city: 'Mumbai',
      state: 'Maharashtra',
      address: 'Dadar West, Mumbai',
      phone: '+912224158800',
      contactPerson: 'Rajesh Kulkarni',
      designation: 'Outreach Manager',
      estStudentsCount: 550,
      status: 'contacted',
      notes: 'Offered 20% commission on paid admissions.',
    },
    {
      name: 'Delhi Public School (DPS) Senior Wing',
      type: 'school',
      city: 'Delhi',
      state: 'Delhi',
      address: 'Sector XII, R.K. Puram, New Delhi',
      phone: '+911149115500',
      contactPerson: 'Meenakshi Sundaram',
      designation: 'Career Guidance Counselor',
      estStudentsCount: 900,
      status: 'identified',
      notes: 'Open for university selection workshops.',
    },
  ];

  await Model.insertMany(samplePartners);
};

