import type { ConfidenceLevel, ConfidenceResult, ObservationRecord, PairDifference } from './types.ts';

function parseUtcTimestamp(dateStr: string): number {
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(dateStr);
  return Date.parse(hasZone ? dateStr : `${dateStr}Z`);
}

export function calculateTd(t1StartDateStr: string | null): number {
  if (!t1StartDateStr) {
    return -1;
  }
  const t1Ms = parseUtcTimestamp(t1StartDateStr);
  if (Number.isNaN(t1Ms)) {
    return -1;
  }
  const deltaMs = Date.now() - t1Ms;
  const days = Math.floor(deltaMs / (1000 * 60 * 60 * 24));
  return Math.max(1, days + 1);
}

export function computeConfidence(observations: ObservationRecord[]): ConfidenceResult {
  if (observations.length === 0) {
    return { category: 'Unknown', aggregated_confidence: 'LOW', score: 0.0 };
  }

  const cat = observations[0].category;
  const sourceWeights: Record<string, number> = { L: 1.0, O: 0.8, G: 0.6, I: 0.4 };
  const confWeights: Record<string, number> = { HIGH: 1.2, MEDIUM: 1.0, LOW: 0.8 };

  let totalScore = 0.0;
  const latestVal = observations[observations.length - 1].qualitative_value;
  let agreeCount = 0;

  for (const obs of observations) {
    const base = sourceWeights[obs.source] ?? 0.5;
    const mult = confWeights[obs.user_confidence] ?? 1.0;
    const score = base * mult;
    if (obs.qualitative_value === latestVal) {
      agreeCount += 1;
      totalScore += score;
    } else {
      totalScore -= score * 0.5;
    }
  }

  let finalScore = totalScore / Math.max(1, observations.length);

  if (agreeCount > 1) {
    finalScore += 0.2 * (agreeCount - 1);
  }

  let aggConf: ConfidenceLevel;
  if (finalScore >= 1.0) {
    aggConf = 'HIGH';
  } else if (finalScore >= 0.6) {
    aggConf = 'MEDIUM';
  } else {
    aggConf = 'LOW';
  }

  return {
    category: cat,
    aggregated_confidence: aggConf,
    score: Math.round(finalScore * 100) / 100,
  };
}

export function computePairDifference(
  m1Obs: ObservationRecord[],
  m2Obs: ObservationRecord[],
): PairDifference[] {
  const m1Latest = new Map<string, string>();
  for (const o of m1Obs) {
    m1Latest.set(o.category, o.qualitative_value);
  }

  const m2Latest = new Map<string, string>();
  for (const o of m2Obs) {
    m2Latest.set(o.category, o.qualitative_value);
  }

  const allCats = new Set<string>([...m1Latest.keys(), ...m2Latest.keys()]);
  const diffs: PairDifference[] = [];

  for (const cat of allCats) {
    const v1 = m1Latest.get(cat) ?? 'NO_DATA';
    const v2 = m2Latest.get(cat) ?? 'NO_DATA';
    diffs.push({
      category: cat,
      m1_val: v1,
      m2_val: v2,
      is_different: v1 !== v2,
    });
  }

  return diffs;
}
