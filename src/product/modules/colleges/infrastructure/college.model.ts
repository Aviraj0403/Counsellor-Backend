import { Schema } from 'mongoose';
import { defineTenantModel } from '../../../../shared/infra/tenantDb.js';
import { COLLEGE_TYPES, COURSE_LEVELS } from '../domain/college.domain.js';

const docSchema = new Schema({ type: { type: String, required: true }, label: { type: String, required: true }, mandatory: { type: Boolean, default: true } }, { _id: false });

const collegeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true, trim: true },
    type: { type: String, enum: COLLEGE_TYPES, default: 'college' },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, default: 'India' },
    website: String,
    contact: { name: String, email: String, phone: String },
    affiliation: String,
    accreditations: [String],
    description: { type: String, maxlength: 4000 },
    requiredDocuments: [docSchema],
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
collegeSchema.index({ slug: 1 }, { unique: true });
collegeSchema.index({ city: 1, state: 1, type: 1 });
collegeSchema.index({ active: 1, name: 1 });

const courseSchema = new Schema(
  {
    collegeId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    level: { type: String, enum: COURSE_LEVELS, required: true },
    stream: String,
    durationMonths: Number,
    annualFeePaise: { type: Number, required: true, min: 0 },
    totalFeePaise: Number,
    intakes: [{ _id: false, month: Number, year: Number, seats: Number, deadline: Date }],
    eligibility: { minPercentage: Number, requiredExams: [String], notes: String },
    requiredDocuments: [docSchema],
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
courseSchema.index({ collegeId: 1, name: 1, level: 1 }, { unique: true });
courseSchema.index({ active: 1, level: 1, annualFeePaise: 1 });

export const CollegeModel = defineTenantModel('College', collegeSchema);
export const CourseModel = defineTenantModel('Course', courseSchema);
