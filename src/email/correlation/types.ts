import type { PendingTransactionItem } from '../../core/pending.js';
import type { WalletRecordItem } from '../../wallet/types.js';
import type {
  TransactionEvidence,
  CorrelationConfidence,
  CorrelationSuggestedAction,
  CorrelationMatchTarget,
} from '../types.js';

export interface ScoringWeights {
  readonly account: number;
  readonly time: number;
  readonly merchant: number;
}

export const DEFAULT_CORRELATION_WEIGHTS: ScoringWeights = {
  account: 0.40,
  time: 0.35,
  merchant: 0.25,
};

export const DEFAULT_TIME_HALF_LIFE_MS = 120 * 60 * 1000; // 120 minutes (2 hours)
export const DEFAULT_MAX_CORRELATION_WINDOW_MS = 120 * 60 * 1000; // 120 minutes (2 hours)
export const DEFAULT_HIGH_CONFIDENCE_THRESHOLD = 0.80;
export const DEFAULT_MEDIUM_CONFIDENCE_THRESHOLD = 0.55;
export const DEFAULT_DISAMBIGUATION_DELTA = 0.08;

export interface CorrelationDimensionScores {
  readonly account: number;
  readonly time: number;
  readonly merchant: number;
  readonly composite: number;
  readonly reasons: string[];
}

export interface Gate1Result {
  readonly passed: boolean;
  readonly reason?: string;
}

export interface Gate2Result {
  readonly matched: boolean;
  readonly matchedReference?: string;
  readonly matchTarget?: CorrelationMatchTarget;
  readonly suggestedAction?: CorrelationSuggestedAction;
  readonly reasons: string[];
}

export interface ScoredCandidate {
  readonly target: CorrelationMatchTarget;
  readonly candidateItem: PendingTransactionItem | WalletRecordItem;
  readonly scores: CorrelationDimensionScores;
}

export interface EngineCorrelationResult {
  readonly confidence: CorrelationConfidence;
  readonly matchTarget: CorrelationMatchTarget;
  readonly reasons: string[];
  readonly suggestedAction: CorrelationSuggestedAction;
  readonly fusedPendingItem?: Partial<PendingTransactionItem>;
  readonly clarificationPrompt?: string;
  readonly scores?: CorrelationDimensionScores;
  readonly proposedTransfer?: {
    pairingMode: 'existing';
    recordId: string;
    accountId?: string;
  };
}
