import type { PendingTransactionItem } from '../core/pending.js';
import type { WalletRecordItem } from '../wallet/types.js';
import type {
  TransactionEvidence,
  CorrelationResult,
  BankSourceCandidate,
  PaymentSourceCandidate,
  ResolvedAccountDetails,
  ResolvedCategoryDetails,
  ComplementaryEvaluationOptions,
  ComplementaryEvaluationResult,
  TransactionCorrelationOptions,
} from './types.js';
import { CommercePlatformRegistry } from '../config/commercePlatforms.js';
import {
  isGenericMerchant,
  isGenericCardAccountOrMethod,
  isGenericNote,
} from './transactionFusion.js';
import { TransactionCorrelationEngine } from './correlation/engine.js';
import { InformationDensityResolver } from './correlation/densityResolver.js';

export type {
  BankSourceCandidate,
  PaymentSourceCandidate,
  ResolvedAccountDetails,
  ResolvedCategoryDetails,
  ComplementaryEvaluationOptions,
  ComplementaryEvaluationResult,
  TransactionCorrelationOptions,
};

/**
 * Coordinates transaction correlation analysis across bank email, payment receipts,
 * push notifications, pending transaction items, and native Wallet records.
 * Powered by the Unified Multi-Signal Correlation & Scoring Engine.
 */
export class TransactionCorrelationService {
  private readonly engine: TransactionCorrelationEngine;
  private readonly densityResolver: InformationDensityResolver;

  constructor(options?: TransactionCorrelationOptions) {
    const platformRegistry =
      options?.platformRegistry ?? CommercePlatformRegistry.getInstance();
    this.densityResolver = new InformationDensityResolver();
    this.engine = new TransactionCorrelationEngine(
      {
        platformRegistry,
        densityResolver: this.densityResolver,
      },
      {
        maxWindowMs: options?.maxCorrelationWindowMilliseconds ?? 120 * 60 * 1000,
      }
    );
  }

  /**
   * Checks whether a merchant or counterparty name is generic or placeholder (e.g. "Unknown", "Kartu Debit").
   */
  public isGenericMerchant(merchant: string | undefined | null): boolean {
    return isGenericMerchant(merchant);
  }

  /**
   * Checks whether an account hint, payment method, or account name refers to a generic card network
   * (e.g. "Visa", "Mastercard", "Debit Card", "Kartu Debit").
   */
  public isGenericCardAccountOrMethod(text?: string | null): boolean {
    return isGenericCardAccountOrMethod(text);
  }

  /**
   * Checks whether a transaction note is boilerplate / generic payment metadata
   * (e.g. "Transaction using Jago debit card", "Pembayaran QRIS") rather than rich itemized details.
   */
  public isGenericNote(
    note: string | undefined | null,
    merchantOrCounterParty?: string | null,
    subject?: string | null
  ): boolean {
    return isGenericNote(note, merchantOrCounterParty, subject);
  }

  /**
   * Evaluates incoming evidence against existing pending candidates and recent Wallet records.
   * Produces a deterministic correlation decision with confidence and suggested action
   * via the Unified Multi-Signal Correlation & Scoring Engine.
   */
  public correlateEvidence(
    incomingEvidence: TransactionEvidence,
    existingPendingItems: PendingTransactionItem[],
    recentWalletRecords: WalletRecordItem[] = []
  ): CorrelationResult {
    return this.engine.correlate(
      incomingEvidence,
      existingPendingItems,
      recentWalletRecords
    );
  }

  /**
   * Fuses existing candidate state with incoming evidence according to field precedence rules.
   * Ensures arrival order invariance: (Bank + Receipt) produces the same outcome as (Receipt + Bank).
   */
  public fuseCandidateWithEvidence(
    candidate: PendingTransactionItem,
    incoming: TransactionEvidence
  ): Partial<PendingTransactionItem> {
    return this.densityResolver.fusePendingItemWithEvidence(candidate, incoming);
  }
}
