export type ModuleState = 'PRE' | 'T1';
export type ObservationSource = 'G' | 'O' | 'I' | 'L';
export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ModuleRecord {
  id: string;
  name: string;
  pair_id: string;
  state: ModuleState;
  t1_start_date: string | null;
  current_td?: number | null;
}

export interface ObservationCreate {
  module_id: string;
  category: string;
  qualitative_value: string;
  source: ObservationSource;
  user_confidence: ConfidenceLevel;
  comment: string;
}

export interface ObservationRecord extends ObservationCreate {
  id: number;
  timestamp: string;
}

export interface PairDifference {
  category: string;
  m1_val: string;
  m2_val: string;
  is_different: boolean;
}

export interface ConfidenceResult {
  category: string;
  aggregated_confidence: ConfidenceLevel;
  score: number;
}
