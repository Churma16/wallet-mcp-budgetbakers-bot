import type {
  WalletMcpRecordTypeValue,
} from './constants.js';

export interface WalletAccountItem {
  id: string;
  name: string;
  currency?: string;
  balance?: number;
  accountType?: string;
  bankAccountNumber?: string;
  isBankSynced?: boolean;
}

export interface WalletCategoryItem {
  id: string;
  name: string;
  parentCategoryId?: string;
  parentCategoryName?: string;
  group?: {
    id: string;
    name: string;
  };
  systemId?: string;
  cardinality?: string;
  customCategory?: boolean;
  archived?: boolean;
  enabled?: boolean;
  isAssignable?: boolean;
}

export interface WalletTransferInput {
  pairingMode: 'new' | 'existing' | 'unpaired';
  accountId?: string;
  accountHint?: string;
  recordId?: string;
  counterAmount?: {
    value: number;
    currencyCode: string;
  };
}

export interface WalletLabelItem {
  id: string;
  name: string;
  color?: string;
  icon?: string;
}

export interface CreateRecordInputPayload {
  accountId: string;
  accountHint?: string;
  amount: number;
  recordDate?: string;
  categoryId?: string;
  categoryHint?: string;
  note?: string;
  counterParty?: string;
  labelIds?: string[];
  labels?: string[];
  currency?: string;
  transfer?: WalletTransferInput;
}

export interface WalletAgentHint {
  type: string;
  severity?: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface WalletCreateRecordsResponse {
  summary?: {
    total: number;
    succeeded: number;
    failed?: number;
    clientErrors?: number;
    serverErrors?: number;
    documentsWritten?: number;
  };
  agentHints?: WalletAgentHint[];
  results?: Array<{
    id?: string;
    inputIndex?: number;
    success: boolean;
    error?: string;
    errorType?: string;
    fields?: string[];
    pairingMode?: string;
    createdMirrorRecordId?: string;
    isMirror?: boolean;
    resultType?: 'root' | 'mirror';
    mirrorOfRecordId?: string;
    record?: Record<string, unknown>;
  }>;
}

export interface PatchRecordInputPayload {
  id: string;
  amount?: number;
  categoryId?: string;
  categoryName?: string;
  labelIds?: string[];
  labels?: string[];
  note?: string;
  counterParty?: string;
  recordDate?: string;
}

export interface WalletPatchRecordsResponse {
  summary?: {
    total: number;
    succeeded: number;
    failed?: number;
    clientErrors?: number;
    serverErrors?: number;
    documentsWritten?: number;
  };
  agentHints?: WalletAgentHint[];
  results?: Array<{
    id?: string;
    inputIndex?: number;
    success: boolean;
    error?: string;
    errorType?: string;
    fields?: string[];
    record?: Record<string, unknown>;
  }>;
}

export interface WalletBudgetItem {
  id: string;
  name: string;
  spentAmount?: number;
  limitAmount?: number;
  remainingAmount?: number;
  currency?: string;
  isClosed?: boolean;
  period?: string;
  periodType?: string;
  isOverspent?: boolean;
}

export interface WalletRecordItem {
  id: string;
  accountId: string;
  accountName?: string;
  amount: number;
  currency: string;
  recordDate: string;
  recordType: WalletMcpRecordTypeValue;
  category?: {
    id: string;
    name: string;
    color?: string;
    group?: string;
  };
  note?: string;
  counterParty?: string;
  labels?: Array<{
    id: string;
    name: string;
    color?: string;
    icon?: string;
  }>;
  recordState?: string;
  source?: string;
  transfer?: {
    type: string;
    transferId?: string;
    mirrorRecord?: unknown;
  } | null;
}

export interface WalletRecordAggregationQueryPayload {
  groupBy?: string[];
  compute?: string[];
  sortBy?: string[];
  accountId?: string | string[];
  recordDate?: string[];
  categoryId?: string[];
  categoryGroup?: string;
  labelId?: string;
  recordType?: 'expense' | 'income';
  source?: string[];
  recordState?: string[];
  isTransfer?: boolean;
  amount?: string[];
  note?: string;
  counterParty?: string;
  limit?: number;
  offset?: number;
}

export interface WalletRecordAggregationResultItem {
  currency?: string;
  recordType?: 'expense' | 'income';
  count: number;
  'amount:sum'?: number;
  'amount:absSum'?: number;
  'category:id'?: string;
  'category:name'?: string;
  'category:parentId'?: string | null;
  'category:customCategory'?: boolean;
  accountId?: string;
  [key: string]: unknown;
}

export interface WalletRecordAggregationResponse {
  results: WalletRecordAggregationResultItem[];
  isTransfer?: boolean | null;
  baseCurrency?: string;
  limit: number;
  offset: number;
  agentHints?: WalletAgentHint[];
  _meta?: {
    rateLimit?: {
      capacity?: number;
      remaining?: number;
      refillPerMinute?: number;
      resetAt?: string;
    };
    syncedAt?: string;
    lastResourceChange?: unknown;
  };
}

export * from './history/queryTypes.js';
export * from './mcp/capabilityTypes.js';
