import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { hashPassword } from '../src/core/modules/identity/infrastructure/security.js';
import { User } from '../src/core/modules/identity/infrastructure/user.model.js';
import { Tenant } from '../src/core/modules/organisations/infrastructure/tenant.model.js';
import { LeadModel } from '../src/product/modules/leads/infrastructure/lead.model.js';
import { StudentModel } from '../src/product/modules/students/infrastructure/student.model.js';
import { CollegeModel, CourseModel } from '../src/product/modules/colleges/infrastructure/college.model.js';
import { ApplicationModel } from '../src/product/modules/applications/infrastructure/application.model.js';
import { BatchModel, SessionModel } from '../src/product/modules/students/infrastructure/batch.model.js';
import { ReferralModel, ReferralProgramModel } from '../src/product/modules/leads/infrastructure/referral.model.js';
import { StudentFeeLinkModel } from '../src/product/modules/applications/infrastructure/feeLink.model.js';
import { TemplateModel } from '../src/product/modules/whatsapp/infrastructure/whatsapp.model.js';
import { BroadcastCampaignModel } from '../src/product/modules/whatsapp/infrastructure/campaign.model.js';
import { PoptinConfigModel } from '../src/product/modules/leads/infrastructure/poptin.model.js';
import { TaskModel } from '../src/product/modules/followups/infrastructure/followup.model.js';

async function seed() {
  console.log('Connecting to Mongo:', env.MONGO_URI);
  await mongoose.connect(env.MONGO_URI, { dbName: 'cp_master' });

  // 1. Ensure SuperAdmin
  const superAdminEmail = 'admin@jdinfotechsolutions.in';
  const superAdminPass = 'Admin@123456';
  let sa = await User.findOne({ email: superAdminEmail });
  if (!sa) {
    sa = await User.create({
      email: superAdminEmail,
      name: 'JD Super Admin',
      passwordHash: await hashPassword(superAdminPass),
      role: 'superadmin',
      tenantId: null,
      status: 'active',
    });
    console.log(`Created SuperAdmin: ${superAdminEmail}`);
  }

  // 2. Create / Update Sample Organisation 00001
  const orgSlug = 'apex-counselling';
  let tenant = await Tenant.findOne({ slug: orgSlug });
  if (!tenant) {
    tenant = await Tenant.create({
      projectId: '00001',
      name: 'Apex Educational Counsellors',
      slug: orgSlug,
      status: 'active',
      logoUrl: 'https://images.unsplash.com/photo-1546410531-bb4caa6b424d?w=200&h=200&fit=crop',
      brandColor: '#2563eb',
      modules: {
        leads: true,
        team: true,
        followups: true,
        students: true,
        colleges: true,
        applications: true,
        documents: true,
        commissions: true,
        ledger: true,
        reports: true,
        whatsapp: true,
        metaAds: true,
        seoPages: true,
        publicApi: true,
        studentPortal: true,
        collegePortal: true,
        appointments: true,
        aiBot: true,
      },
      settings: { counsellorAllStudentsVisible: true },
    });
    console.log(`Created Tenant: ${tenant.name} (ID: ${tenant._id}, Project: ${tenant.projectId})`);
  } else {
    // ensure all modules on
    tenant.projectId = '00001';
    tenant.modules = {
      leads: true,
      team: true,
      followups: true,
      students: true,
      colleges: true,
      applications: true,
      documents: true,
      commissions: true,
      ledger: true,
      reports: true,
      whatsapp: true,
      metaAds: true,
      seoPages: true,
      publicApi: true,
      studentPortal: true,
      collegePortal: true,
      appointments: true,
      aiBot: true,
    };
    await tenant.save();
    console.log(`Updated Tenant modules for: ${tenant.name}`);
  }

  const tenantId = String(tenant._id);

  // 3. Create Tenant Owner & Counsellor Staff
  const ownerEmail = 'owner@apexcounselling.com';
  const counsellorEmail = 'priya@apexcounselling.com';

  let owner = await User.findOne({ email: ownerEmail });
  if (!owner) {
    owner = await User.create({
      email: ownerEmail,
      phone: '+919876543200',
      name: 'Rajesh Khurana (Owner)',
      passwordHash: await hashPassword('Owner@123456'),
      role: 'owner',
      tenantId,
      status: 'active',
    });
    console.log(`Created Owner: ${ownerEmail} (Password: Owner@123456)`);
  }

  let counsellor = await User.findOne({ email: counsellorEmail });
  if (!counsellor) {
    counsellor = await User.create({
      email: counsellorEmail,
      phone: '+919876543201',
      name: 'Priya Sharma (Senior Counsellor)',
      passwordHash: await hashPassword('Priya@123456'),
      role: 'counsellor',
      tenantId,
      status: 'active',
    });
    console.log(`Created Counsellor: ${counsellorEmail} (Password: Priya@123456)`);
  }

  // 4. Seed Colleges & Courses in Tenant DB
  const College = CollegeModel(tenantId);
  const Course = CourseModel(tenantId);

  let coep = await College.findOne({ name: 'COEP Technological University' });
  if (!coep) {
    coep = await College.create({
      name: 'COEP Technological University',
      slug: 'coep-pune',
      city: 'Pune',
      state: 'Maharashtra',
      type: 'university',
      website: 'https://www.coep.org.in',
      established: 1854,
    });
  }

  let vjti = await College.findOne({ name: 'VJTI Mumbai' });
  if (!vjti) {
    vjti = await College.create({
      name: 'VJTI Mumbai',
      slug: 'vjti-mumbai',
      city: 'Mumbai',
      state: 'Maharashtra',
      type: 'institute',
      website: 'https://vjti.ac.in',
      established: 1887,
    });
  }

  let coepCse = await Course.findOne({ collegeId: String(coep._id), name: 'B.Tech Computer Engineering' });
  if (!coepCse) {
    coepCse = await Course.create({
      collegeId: String(coep._id),
      name: 'B.Tech Computer Engineering',
      level: 'ug',
      stream: 'Engineering',
      durationYears: 4,
      annualFeePaise: 110_000_00, // ₹1,10,000/yr
      eligibility: { minPercentage: 75 },
      intakes: [{ month: 8, year: 2026 }],
    });
  }

  let vjtiIt = await Course.findOne({ collegeId: String(vjti._id), name: 'B.Tech Information Technology' });
  if (!vjtiIt) {
    vjtiIt = await Course.create({
      collegeId: String(vjti._id),
      name: 'B.Tech Information Technology',
      level: 'ug',
      stream: 'Engineering',
      durationYears: 4,
      annualFeePaise: 95_000_00, // ₹95,000/yr
      eligibility: { minPercentage: 70 },
      intakes: [{ month: 8, year: 2026 }],
    });
  }

  // 5. Seed Students & Portal User
  const Student = StudentModel(tenantId);
  let student1 = await Student.findOne({ phone: '+919820011223' });
  if (!student1) {
    student1 = await Student.create({
      name: 'Aarav Deshmukh',
      phone: '+919820011223',
      email: 'aarav.deshmukh@gmail.com',
      gender: 'male',
      dob: new Date('2007-04-15'),
      address: { line: 'Flat 402, Shivajinagar', city: 'Pune', state: 'Maharashtra', pincode: '411005' },
      guardian: { name: 'Sanjay Deshmukh', phone: '+919820011220', relation: 'Father' },
      academics: [{ level: '12th', board: 'Maharashtra State Board', institute: 'Fergusson College', year: 2025, percentage: 89.4 }],
      testScores: [{ test: 'MHT-CET', score: 98.2, year: 2026 }, { test: 'JEE Main', score: 96.5, year: 2026 }],
      preferences: { courses: ['Computer Science', 'Information Technology'], cities: ['Pune', 'Mumbai'], budgetMaxPaise: 200_000_00 },
      assignedTo: String(counsellor._id),
      consent: { given: true, source: 'website', at: new Date() },
      status: 'active',
    });
    console.log(`Created Student: ${student1.name}`);
  }

  // Create Student Portal Login Account
  const studentEmail = 'aarav.deshmukh@gmail.com';
  let stuUser = await User.findOne({ email: studentEmail });
  if (!stuUser) {
    stuUser = await User.create({
      email: studentEmail,
      phone: '+919820011223',
      name: 'Aarav Deshmukh',
      passwordHash: await hashPassword('Student@123456'),
      role: 'student',
      tenantId,
      linkedId: String(student1._id),
      status: 'active',
    });
    console.log(`Created Student Portal User: ${studentEmail} (Password: Student@123456)`);
  }

  // 6. Seed Application for Student
  const Application = ApplicationModel(tenantId);
  let app1 = await Application.findOne({ studentId: String(student1._id), courseId: String(coepCse._id) });
  if (!app1) {
    app1 = await Application.create({
      studentId: String(student1._id),
      collegeId: String(coep._id),
      courseId: String(coepCse._id),
      intake: { month: 8, year: 2026 },
      status: 'submitted',
      assignedTo: String(counsellor._id),
      collegeRef: 'COEP-2026-ENG-4921',
      fee: { applicationFeePaise: 2000_00, tuitionPaise: 110_000_00, paidPaise: 2000_00 },
      statusHistory: [
        { from: 'draft', to: 'submitted', by: String(counsellor._id), at: new Date(), note: 'Application submitted to state CAP portal' },
      ],
      notes: 'Category: General / Open. Excellent 12th PCM score.',
    });
    console.log(`Created Application for Aarav in COEP`);
  }

  // 7. Seed Razorpay Fee Link for Seat Advance
  const FeeLink = StudentFeeLinkModel(tenantId);
  let feeLink = await FeeLink.findOne({ studentId: String(student1._id) });
  if (!feeLink) {
    feeLink = await FeeLink.create({
      studentId: String(student1._id),
      applicationId: String(app1._id),
      title: 'COEP Counselling Seat Confirmation Deposit',
      amountPaise: 25000_00, // ₹25,000
      status: 'created',
      shortUrl: 'https://rzp.io/i/sim_apex_coep',
      razorpayLinkId: 'plink_sim_apex_01',
      notes: 'Initial seat booking advance fee',
      createdBy: String(counsellor._id),
    });
    console.log(`Created Fee Link for Aarav`);
  }

  // 8. Seed Batches & Sessions
  const Batch = BatchModel(tenantId);
  const Session = SessionModel(tenantId);
  let batch1 = await Batch.findOne({ name: '2026 MHT-CET Engineering FastTrack' });
  if (!batch1) {
    batch1 = await Batch.create({
      name: '2026 MHT-CET Engineering FastTrack',
      academicYear: '2026-2027',
      courseStream: 'B.Tech / Engineering',
      counsellorId: String(counsellor._id),
      studentIds: [String(student1._id)],
      capacity: 45,
      status: 'active',
      notes: 'Targeting top Maharashtra institutes (COEP, VJTI, PICT, SPIT)',
      createdBy: String(owner._id),
    });
    console.log(`Created Batch: ${batch1.name}`);
  }

  let session1 = await Session.findOne({ batchId: String(batch1._id) });
  if (!session1) {
    session1 = await Session.create({
      batchId: String(batch1._id),
      title: 'CAP Round 1 Option Form Preference Ordering Workshop',
      sessionDate: new Date('2026-11-28T10:00:00Z'),
      startTime: '10:00 AM',
      endTime: '11:30 AM',
      venue: 'Main Seminar Hall & Zoom Link',
      status: 'completed',
      attendance: [
        {
          studentId: String(student1._id),
          status: 'present',
          markedAt: new Date(),
          notes: 'Option form verified and finalized',
        },
      ],
      createdBy: String(counsellor._id),
    });
    console.log(`Created Session & marked Aarav present`);
  }

  // 9. Seed Leads & Follow-ups
  const Lead = LeadModel(tenantId);
  const Task = TaskModel(tenantId);

  let lead1 = await Lead.findOne({ phone: '+919988776611' });
  if (!lead1) {
    lead1 = await Lead.create({
      name: 'Neha Kulkarni',
      phone: '+919988776611',
      email: 'neha.k@gmail.com',
      city: 'Pune',
      interestedCourse: 'B.Tech Computer Science',
      source: { channel: 'website', utmSource: 'google_search', utmMedium: 'cpc' },
      stage: 'contacted',
      assignedTo: String(counsellor._id),
      consent: { given: true, source: 'website', at: new Date() },
      createdBy: String(owner._id),
    });

    await Task.create({
      entityType: 'lead',
      entityId: String(lead1._id),
      title: 'Discuss MHT-CET score & COEP cutoff eligibility',
      dueAt: new Date(Date.now() + 86400000), // tomorrow
      status: 'open',
      assignedTo: String(counsellor._id),
      createdBy: String(counsellor._id),
    });
    console.log(`Created Lead: Neha Kulkarni with active task`);
  }

  // 10. Seed Referral Program & Student Referral Code
  const Program = ReferralProgramModel(tenantId);
  const Referral = ReferralModel(tenantId);

  let prog = await Program.findOne();
  if (!prog) {
    await Program.create({
      enabled: true,
      rewardAmountRupees: 2000,
      rewardDescription: '₹2,000 Amazon Gift Voucher or Tuition Fee Cashback',
    });
  }

  let ref1 = await Referral.findOne({ referredPhone: '+919988776611' });
  if (!ref1) {
    await Referral.create({
      referralCode: `AAR${String(student1._id).slice(-3).toUpperCase()}`,
      referrerStudentId: String(student1._id),
      referrerName: student1.name,
      referrerPhone: student1.phone,
      referredLeadId: String(lead1._id),
      referredName: lead1.name,
      referredPhone: lead1.phone,
      status: 'pending',
      rewardAmountRupees: 2000,
    });
    console.log(`Created Referral linked from Aarav -> Neha`);
  }

  // 11. Seed WhatsApp Templates & Broadcast Campaign
  const Template = TemplateModel(tenantId);
  let tpl = await Template.findOne({ name: 'btech_spot_round_alert' });
  if (!tpl) {
    tpl = await Template.create({
      name: 'btech_spot_round_alert',
      language: 'en',
      body: 'Hello {{1}}, spot round admissions have opened for {{2}} in {{3}}. Connect with your counsellor today!',
      purpose: 'Spot round notifications',
      active: true,
    });
  }

  const Campaign = BroadcastCampaignModel(tenantId);
  let camp = await Campaign.findOne({ name: 'Spot Round 2026 Priority Blast' });
  if (!camp) {
    await Campaign.create({
      name: 'Spot Round 2026 Priority Blast',
      template: 'btech_spot_round_alert',
      language: 'en',
      audience: 'leads',
      status: 'completed',
      stats: { total: 12, sent: 11, failed: 0, skippedNoConsent: 1 },
      completedAt: new Date(),
      createdBy: String(owner._id),
    });
    console.log(`Created WhatsApp Campaign`);
  }

  // 12. Seed In-House Lead Popup (Poptin)
  const Poptin = PoptinConfigModel(tenantId);
  await Poptin.findOneAndUpdate(
    {},
    {
      $set: {
        enabled: true,
        headline: 'Find Your Dream B.Tech Engineering College in Maharashtra!',
        subheadline: 'Get free spot-round cutoffs, scholarship alerts, and seat matrix assistance.',
        design: {
          themeColor: '#2563eb',
          buttonText: 'Get Free Counselling Call',
          buttonColor: '#2563eb',
          buttonTextColor: '#ffffff',
          backgroundColor: '#ffffff',
          textColor: '#0f172a',
        },
        triggers: {
          exitIntent: true,
          timeDelaySeconds: 10,
          scrollPercentage: 40,
        },
        stats: { impressions: 1420, conversions: 86 },
      },
    },
    { upsert: true },
  );
  console.log(`Configured In-House Lead Popup Engine`);

  console.log('\n======================================================');
  console.log('✅ ALL MODULES SEEDED WITH REALISTIC INTERCONNECTED DATA');
  console.log('======================================================');
  console.log('Tenant: Apex Educational Counsellors (ID: 00001, Slug: apex-counselling)');
  console.log('Super Admin: admin@jdinfotechsolutions.in (Pass: Admin@123456)');
  console.log('Tenant Owner: owner@apexcounselling.com (Pass: Owner@123456)');
  console.log('Counsellor: priya@apexcounselling.com or +919876543201 (Pass: Priya@123456)');
  console.log('Student Portal: aarav.deshmukh@gmail.com or +919820011223 (Pass: Student@123456)');
  console.log('======================================================\n');

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
