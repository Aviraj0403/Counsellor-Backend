import type { CourseLike, CollegeLike } from './college.domain.js';

export interface PredictorInput {
  exam: 'jee_main' | 'mht_cet' | 'wbjee' | 'kcet' | 'direct_12th';
  rank?: number;
  percentile?: number;
  percentage?: number;
  category: 'general' | 'obc' | 'sc' | 'st' | 'ews' | 'management';
  preferredBranches?: string[];
  preferredCities?: string[];
  budgetMaxPaise?: number;
}

export interface PredictionResult {
  chance: 'high' | 'medium' | 'low';
  collegeId: string;
  collegeName: string;
  courseId: string;
  courseName: string;
  stream?: string;
  city?: string;
  state?: string;
  annualFeePaise: number;
  cutoffEstimate: string;
  matchScore: number;
  reason: string;
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

/**
 * Predicts B.Tech college admission chances based on rank/percentile/marks, category reservations,
 * location preferences, and branch cutoffs.
 */
export const predictColleges = (
  items: { course: CourseLike; college: CollegeLike }[],
  input: PredictorInput,
): { total: number; predictions: PredictionResult[] } => {
  const branches = (input.preferredBranches ?? []).map(norm).filter(Boolean);
  const cities = (input.preferredCities ?? []).map(norm).filter(Boolean);
  const out: PredictionResult[] = [];

  // Effective score baseline (0 to 100)
  let userScore = 50;
  if (input.percentile !== undefined) {
    userScore = input.percentile;
  } else if (input.percentage !== undefined) {
    userScore = input.percentage;
  } else if (input.rank !== undefined) {
    // Inverse scale for rank (e.g. Rank 1 = 99.99, Rank 150000 = ~50, Rank 300000 = ~20)
    userScore = Math.max(10, Math.min(99.9, 100 - (input.rank / 3000)));
  }

  // Category advantage offset (reservation benefit in cutoffs)
  let categoryBonus = 0;
  if (input.category === 'obc' || input.category === 'ews') categoryBonus = 5;
  if (input.category === 'sc') categoryBonus = 12;
  if (input.category === 'st') categoryBonus = 18;
  if (input.category === 'management') categoryBonus = 20;

  const effectiveUserScore = Math.min(100, userScore + categoryBonus);

  for (const { course, college } of items) {
    // Only B.Tech / UG Engineering courses
    if (course.level !== 'ug') continue;

    // Filter budget
    if (input.budgetMaxPaise !== undefined && input.budgetMaxPaise > 0 && course.annualFeePaise > input.budgetMaxPaise) {
      continue;
    }

    // Filter cities if specified
    if (cities.length && !cities.includes(norm(college.city))) {
      continue;
    }

    // Filter branches if specified
    const courseName = norm(course.name);
    const stream = norm(course.stream);
    const branchMatched = branches.length
      ? branches.some((b) => courseName.includes(b) || stream.includes(b))
      : true;

    if (branches.length && !branchMatched) continue;

    // Determine course required cutoff threshold
    const minMarks = course.eligibility?.minPercentage ?? 50;
    // Base cutoff estimate derived from college popularity & course stream (e.g., Computer Science has higher cutoff)
    const isCSEorIT = courseName.includes('comp') || courseName.includes('cs') || courseName.includes('it') || courseName.includes('ai') || courseName.includes('data');
    const estimatedCutoff = minMarks + (isCSEorIT ? 20 : 10);

    const scoreDiff = effectiveUserScore - estimatedCutoff;

    let chance: 'high' | 'medium' | 'low';
    let reason = '';

    if (scoreDiff >= 10) {
      chance = 'high';
      reason = `Strong admission probability: Your effective score (${effectiveUserScore.toFixed(1)}) comfortably exceeds the estimated cutoff (${estimatedCutoff}).`;
    } else if (scoreDiff >= -5) {
      chance = 'medium';
      reason = `Moderate admission probability: Your score is competitive for regular/round 2 counselling for ${input.category.toUpperCase()} category.`;
    } else {
      chance = 'low';
      reason = `Ambitious option: Requires spot round counselling, institutional quota or management seat.`;
    }

    const matchScore = Math.min(100, Math.max(10, Math.round(50 + scoreDiff * 2 + (branchMatched ? 10 : 0))));

    out.push({
      chance,
      collegeId: college.id,
      collegeName: college.name,
      courseId: course.id,
      courseName: course.name,
      stream: course.stream,
      city: college.city,
      state: college.state,
      annualFeePaise: course.annualFeePaise,
      cutoffEstimate: `~${estimatedCutoff}% marks / percentile`,
      matchScore,
      reason,
    });
  }

  // Sort by match score descending, then fee
  const sorted = out.sort((a, b) => b.matchScore - a.matchScore || a.annualFeePaise - b.annualFeePaise);

  return { total: sorted.length, predictions: sorted };
};

