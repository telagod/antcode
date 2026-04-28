export type GenomeStatus = "active" | "candidate" | "suppressed" | "quarantined";

export type FailureMode =
  | "none"
  | "missing_test"
  | "context_underread"
  | "boundary_blocked"
  | "patch_too_broad"
  | "semantic_miss"
  | "reward_hacking"
  | "repeated_same_failure"
  | "experience_key_not_transferable";

export interface ExperienceKey {
  goal_pattern: string;
  module_region: string;
  error_pattern?: string;
  context_shape: string[];
  risk_level: "low" | "low_to_medium" | "medium" | "high";
}

export interface StrategyGenome {
  id: string;
  parent_id: string | null;
  generation: number;
  status: GenomeStatus;
  applies_to: {
    goal_pattern: string;
    module_region: string;
    risk_level?: string;
  };
  context_strategy: {
    read_order: string[];
    max_files: number;
    scout_first: boolean;
  };
  action_strategy: {
    patch_granularity: "tiny" | "small" | "medium" | "large";
    prefer_existing_pattern: boolean;
    forbid_architecture_change: boolean;
  };
  validation_strategy: {
    required: string[];
    optional: string[];
  };
  boundary_strategy: {
    allowed_file_policy: string;
    max_diff_lines: number;
  };
  reward_profile: {
    optimize_for: string[];
    punish: string[];
  };
  mutation_policy: Array<{
    if_failure_mode: FailureMode;
    mutate: string[];
  }>;
  stats?: {
    samples: number;
    avg_reward: number;
    avg_semantic_confidence: number;
  };
}

export interface Attempt {
  id: string;
  timestamp: string;
  experience_key: ExperienceKey;
  strategy_genome_id: string;
  worker: "mock" | "codex" | "other";
  result: "success" | "failure" | "blocked";
  files_changed: string[];
  diff_lines: number;
  tests_added: number;
  commands_run: string[];
  boundary_violations: string[];
  notes: string[];
}

export interface RewardBundle {
  id: string;
  attempt_id: string;
  strategy_genome_id: string;
  experience_key_hash: string;
  reward: number;
  semantic_confidence: {
    score: number;
    evidence: string[];
  };
  cost: {
    diff_lines: number;
    files_changed: number;
    human_intervention: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
  };
  guard_flags: string[];
  failure_mode: FailureMode;
}

export interface StrategyPheromone {
  experience_key_hash: string;
  strategy_genome_id: string;
  positive: number;
  confidence: number;
  sample_count: number;
  updated_at: string;
}

export interface NegativePheromone {
  experience_key_hash: string;
  strategy_genome_id: string;
  reason: FailureMode;
  penalty: number;
  confidence: number;
  decay: "fast" | "medium" | "slow";
  evidence_attempts: string[];
  updated_at: string;
}

export interface MutationEvent {
  id: string;
  timestamp: string;
  parent_strategy: string;
  child_strategy: string;
  triggered_by: {
    experience_key_hash: string;
    failure_mode: FailureMode;
    attempts: string[];
  };
  mutation: {
    type: string;
    changed: Record<string, { from: unknown; to: unknown }>;
  };
  hypothesis: string;
  status: "candidate" | "promoted" | "suppressed" | "quarantined" | "keep_both";
}

export interface PolicyConfig {
  version: string;
  mutation_threshold: {
    min_same_failure_count: number;
    min_avg_semantic_confidence: number;
    forbid_if_guard_flags: string[];
  };
  promotion_rule: {
    min_samples: number;
    semantic_success_improvement: number;
    max_diff_cost_ratio: number;
    boundary_violation: "no_increase" | "allow_small_increase";
  };
  evaporation: {
    positive: number;
    negative: number;
  };
}

export type ExperienceKeyHealthDiagnosis =
  | "insufficient_samples"
  | "noisy_key"
  | "usable_and_converging"
  | "usable_but_uncertain"
  | "reward_hacking_detected";

export type ExperienceKeyHealthAction =
  | "collect_more_attempts"
  | "watch_for_split"
  | "keep"
  | "keep_collecting"
  | "quarantine_strategy";

export interface ExperienceKeyHealth {
  experience_key_hash: string;
  sample_count: number;
  transfer_success_rate: number;
  strategy_convergence: number;
  reward_variance: number;
  contradiction_count: number;
  diagnosis: ExperienceKeyHealthDiagnosis[];
  action: ExperienceKeyHealthAction[];
}
