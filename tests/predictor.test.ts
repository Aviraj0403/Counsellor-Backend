import { describe, expect, it } from 'vitest';
import {
  predictColleges,
  type PredictorInput,
} from '../src/product/modules/colleges/domain/predictor.domain.js';
import type { CollegeLike, CourseLike } from '../src/product/modules/colleges/domain/college.domain.js';

describe('B.Tech Predictor Domain', () => {
  const colleges: CollegeLike[] = [
    { id: 'col-1', name: 'COEP Technological University', city: 'Pune', state: 'Maharashtra' },
    { id: 'col-2', name: 'VJTI Mumbai', city: 'Mumbai', state: 'Maharashtra' },
    { id: 'col-3', name: 'MIT World Peace University', city: 'Pune', state: 'Maharashtra' },
  ];

  const courses: CourseLike[] = [
    {
      id: 'c-1',
      name: 'B.Tech Computer Science and Engineering',
      level: 'ug',
      stream: 'Engineering',
      annualFeePaise: 180_000_00,
      intakes: [],
      eligibility: { minPercentage: 60 },
    },
    {
      id: 'c-2',
      name: 'B.Tech Mechanical Engineering',
      level: 'ug',
      stream: 'Engineering',
      annualFeePaise: 120_000_00,
      intakes: [],
      eligibility: { minPercentage: 55 },
    },
    {
      id: 'c-3',
      name: 'MBA Marketing',
      level: 'pg',
      stream: 'Management',
      annualFeePaise: 250_000_00,
      intakes: [],
    },
  ];

  const dataset = [
    { course: courses[0]!, college: colleges[0]! },
    { course: courses[1]!, college: colleges[0]! },
    { course: courses[0]!, college: colleges[1]! },
    { course: courses[0]!, college: colleges[2]! },
    { course: courses[2]!, college: colleges[2]! }, // PG should be skipped
  ];

  it('filters out non-UG courses and matches preferred branch', () => {
    const input: PredictorInput = {
      exam: 'jee_main',
      percentile: 98,
      category: 'general',
      preferredBranches: ['Computer Science'],
    };

    const res = predictColleges(dataset, input);
    expect(res.total).toBe(3);
    for (const pred of res.predictions) {
      expect(pred.courseName).toContain('Computer Science');
      expect(pred.chance).toBe('high');
    }
  });

  it('applies category reservation advantage in admission chance', () => {
    const genInput: PredictorInput = {
      exam: 'mht_cet',
      percentile: 75,
      category: 'general',
      preferredBranches: ['Computer Science'],
    };

    const scInput: PredictorInput = {
      exam: 'mht_cet',
      percentile: 85,
      category: 'sc',
      preferredBranches: ['Computer Science'],
    };

    const genRes = predictColleges(dataset, genInput);
    const scRes = predictColleges(dataset, scInput);

    expect(scRes.predictions[0]!.matchScore).toBeGreaterThan(genRes.predictions[0]!.matchScore);
    // General student with 75% has medium chance for CSE with cutoff 80
    expect(genRes.predictions[0]!.chance).toBe('medium');
    // SC candidate with 85% + bonus (+12) gets effective score 97, reaching high chance
    expect(scRes.predictions[0]!.chance).toBe('high');
  });

  it('filters by preferred cities and budget', () => {
    const input: PredictorInput = {
      exam: 'direct_12th',
      percentage: 85,
      category: 'general',
      preferredCities: ['Mumbai'],
      budgetMaxPaise: 200_000_00,
    };

    const res = predictColleges(dataset, input);
    expect(res.total).toBe(1);
    expect(res.predictions[0]!.city).toBe('Mumbai');
    expect(res.predictions[0]!.collegeId).toBe('col-2');
  });
});
