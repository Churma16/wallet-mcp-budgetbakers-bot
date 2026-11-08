import type { WalletRecordItem } from '../../wallet/types.js';

export type MutationDirection = 'DEBIT' | 'CREDIT';

export interface BankMutationItem {
  id: string;
  date: string; // ISO date string (YYYY-MM-DD)
  amount: number; // Positive absolute amount
  direction: MutationDirection;
  counterParty: string;
  note?: string;
}

export interface MutationTransformResult {
  counterParty?: string;
  categoryHint?: string;
  note?: string;
}

export interface ReconciliationRule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  targetWalletFilter(walletName: string): boolean;
  matchMutation(mutation: BankMutationItem): boolean;
  applyTransform(mutation: BankMutationItem): MutationTransformResult;
}

export interface MatchedMutationPair {
  mutation: BankMutationItem;
  walletRecord: WalletRecordItem;
}

export interface WrongAccountMutationPair {
  mutation: BankMutationItem;
  walletRecord: WalletRecordItem;
  actualAccountName: string;
}

export interface MissingMutationItem {
  mutation: BankMutationItem;
  suggestedCategoryName?: string;
  note: string;
}

export interface ReconciliationComparisonResult {
  targetAccountId: string;
  targetAccountName: string;
  dateRange: {
    startDate: string; // YYYY-MM-DD
    endDate: string; // YYYY-MM-DD
  };
  totalMutations: number;
  matched: MatchedMutationPair[];
  wrongAccount: WrongAccountMutationPair[];
  missing: MissingMutationItem[];
  extraInWallet: WalletRecordItem[];
}
