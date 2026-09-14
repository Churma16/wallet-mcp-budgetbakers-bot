import { WalletAccountItem, WalletCategoryItem, CreateRecordInputPayload } from '../types/walletTypes.js';
import { getApplicationTimezone } from '../config/applicationConfig.js';
import {
  getTimezoneOffsetDetails,
  parseRelativeTime,
  ParsedRelativeTimeResult,
} from './relativeTimeParser.js';
import { normalizeTransactionRecordDate } from './recordDateNormalizer.js';
import { extractHashtags, deduplicateTags, normalizeTagName } from './hashtagParser.js';
import { parseFinancialAmount, parseFinancialAmountString } from './financialAmountParser.js';
import {
  resolveSemanticAccountHint,
  resolveSemanticCategoryHint,
  SemanticEntityCandidate,
  SemanticEntityResolutionReason,
} from '../services/semanticEntityResolver.js';

export type AccountResolutionIssueReason = 'UNRESOLVED' | 'AMBIGUOUS';

export interface AccountResolutionCandidate {
  id: string;
  name: string;
  bankAccountNumber?: string;
}

export interface AccountResolutionIssue {
  recordIndex: number;
  accountHint: string;
  reason: AccountResolutionIssueReason;
  candidates: AccountResolutionCandidate[];
}

export interface FinancialRecordValidationResult {
  isValid: boolean;
  sanitizedRecords: CreateRecordInputPayload[];
  validationErrors: string[];
  accountResolutionIssues: AccountResolutionIssue[];
  entityResolutionIssues: EntityResolutionIssue[];
}

export interface EntityResolutionIssue {
  recordIndex: number;
  entityType: 'ACCOUNT' | 'CATEGORY';
  hint: string;
  reason: SemanticEntityResolutionReason;
  candidates: SemanticEntityCandidate[];
}

export type FinancialRecordValidationInput = Omit<CreateRecordInputPayload, 'accountId'> & {
  accountId?: string;
};

const MAXIMUM_RECORDS_PER_BATCH = 20;
const MAXIMUM_SINGLE_TRANSACTION_AMOUNT = 100_000_000_000; // 100 billion IDR upper limit for sanity

function toAccountResolutionCandidate(account: WalletAccountItem): AccountResolutionCandidate {
  return {
    id: account.id,
    name: account.name,
    bankAccountNumber: account.bankAccountNumber,
  };
}

/**
 * Validates and sanitizes financial records extracted by AI before dispatching to Wallet MCP.
 * Prevents hallucinatory account IDs, zero/infinite amounts, out-of-range values, and corrupt dates.
 */
export function validateAndSanitizeFinancialRecords(
  incomingRecords: FinancialRecordValidationInput[],
  availableAccountList: WalletAccountItem[],
  availableCategoryList: WalletCategoryItem[],
  contextualUserMessage?: string,
  referenceDate: Date = new Date(),
  sourceUserTextForHashtags?: string
): FinancialRecordValidationResult {
  const validationErrors: string[] = [];
  const sanitizedRecords: CreateRecordInputPayload[] = [];
  const accountResolutionIssues: AccountResolutionIssue[] = [];
  const entityResolutionIssues: EntityResolutionIssue[] = [];

  if (!Array.isArray(incomingRecords) || incomingRecords.length === 0) {
    return {
      isValid: false,
      sanitizedRecords: [],
      validationErrors: ['Tidak ada data transaksi yang dapat divalidasi.'],
      accountResolutionIssues: [],
      entityResolutionIssues: [],
    };
  }

  if (incomingRecords.length > MAXIMUM_RECORDS_PER_BATCH) {
    return {
      isValid: false,
      sanitizedRecords: [],
      validationErrors: [
        `Jumlah transaksi (${incomingRecords.length}) melebihi batas wajar (${MAXIMUM_RECORDS_PER_BATCH} entri per pesan).`,
      ],
      accountResolutionIssues: [],
      entityResolutionIssues: [],
    };
  }

  const applicationTimezone = getApplicationTimezone();

  // Deterministically derive allowed explicit hashtags from raw user input.
  // Raw user input (sourceUserTextForHashtags or contextualUserMessage) is the sole authority for explicit hashtags.
  // Model-generated fields (like record.note) must never authorize new hashtags absent from user input.
  const rawUserTextForHashtags =
    typeof sourceUserTextForHashtags === 'string'
      ? sourceUserTextForHashtags
      : contextualUserMessage;

  const rawSourceHashtags =
    typeof rawUserTextForHashtags === 'string'
      ? extractHashtags(rawUserTextForHashtags).tags
      : undefined;

  const allowedExplicitTagSet = new Set<string>();

  if (rawSourceHashtags !== undefined) {
    for (const tag of rawSourceHashtags) {
      allowedExplicitTagSet.add(tag.toLowerCase());
    }
  } else {
    // When contextualUserMessage is not provided (e.g. standalone validator tests), fall back to note hashtags
    for (const record of incomingRecords) {
      if (record && record.note && typeof record.note === 'string') {
        const noteHashtags = extractHashtags(record.note).tags;
        for (const tag of noteHashtags) {
          allowedExplicitTagSet.add(tag.toLowerCase());
        }
      }
    }
  }

  const invalidRecordIndices = new Set<number>();

  // Pre-normalize recordDate upfront for all records into an immutable UTC ISO string
  // BEFORE account resolution or any validation short-circuits.
  // This guarantees:
  // 1. Account-clarification drafts store the finalized UTC timestamp, preventing date shifts
  //    if the user replies after midnight.
  // 2. Multi-record batches do not have the single contextualUserMessage applied across all records.
  for (let recordIndex = 0; recordIndex < incomingRecords.length; recordIndex++) {
    const currentRecord = incomingRecords[recordIndex];

    // For single-record inputs, prioritize contextualUserMessage (falling back to currentRecord.note).
    // For multi-record inputs, strictly check currentRecord.note per record so records don't inherit
    // whichever relative-time expression appears first in the contextualUserMessage.
    let candidateTextForRelativeTime = '';
    if (contextualUserMessage !== undefined) {
      candidateTextForRelativeTime = incomingRecords.length === 1
        ? (contextualUserMessage || currentRecord.note || '')
        : (currentRecord.note || '');
    } else if (!currentRecord.recordDate) {
      candidateTextForRelativeTime = currentRecord.note || '';
    }

    let parsedRelativeTime: ParsedRelativeTimeResult | null = null;
    if (candidateTextForRelativeTime) {
      try {
        parsedRelativeTime = parseRelativeTime(
          candidateTextForRelativeTime,
          referenceDate,
          applicationTimezone
        );
      } catch (error) {
        if (error instanceof RangeError) {
          validationErrors.push(
            `Transaksi #${recordIndex + 1}: Waktu transaksi tidak valid pada timezone ${applicationTimezone} (${error.message}).`
          );
          invalidRecordIndices.add(recordIndex);
          continue;
        }
        throw error;
      }
    }

    let normalizedRecordDate = currentRecord.recordDate;

    if (parsedRelativeTime) {
      normalizedRecordDate = parsedRelativeTime.resolvedUtcIso;
    } else {
      try {
        normalizedRecordDate = normalizeTransactionRecordDate(
          normalizedRecordDate,
          referenceDate,
          applicationTimezone
        );
      } catch (error) {
        if (error instanceof RangeError) {
          validationErrors.push(
            `Transaksi #${recordIndex + 1}: Waktu transaksi tidak valid pada timezone ${applicationTimezone} (${error.message}).`
          );
          invalidRecordIndices.add(recordIndex);
          continue;
        }
        throw error;
      }
    }

    // Mutate the incoming record upfront to preserve normalized UTC date across drafts & retries
    currentRecord.recordDate = normalizedRecordDate;
  }

  for (let recordIndex = 0; recordIndex < incomingRecords.length; recordIndex++) {
    if (invalidRecordIndices.has(recordIndex)) {
      continue;
    }
    const currentRecord = incomingRecords[recordIndex];
    const recordLabel = `Transaksi #${recordIndex + 1}`;

    // 1. Amount Validation
    const rawAmountValue: unknown = currentRecord.amount;
    const rawRecordCurrency: string | undefined =
      typeof currentRecord.currency === 'string' && currentRecord.currency.trim()
        ? currentRecord.currency.trim().toUpperCase()
        : undefined;

    let parsedAmount: number | null = null;
    let stringAmountCurrencyHint: string | undefined = undefined;

    if (typeof rawAmountValue === 'number') {
      parsedAmount = Number.isFinite(rawAmountValue) ? rawAmountValue : null;
    } else if (typeof rawAmountValue === 'string') {
      // First check if the raw string amount embeds an explicit currency marker
      const embeddedMarkerResult = parseFinancialAmount(rawAmountValue);
      if (embeddedMarkerResult?.explicitCurrencyHint) {
        stringAmountCurrencyHint = embeddedMarkerResult.explicitCurrencyHint.trim().toUpperCase();
      }

      // Reconcile currency hints: record currency vs explicit currency parsed from amount string
      if (rawRecordCurrency && stringAmountCurrencyHint && rawRecordCurrency !== stringAmountCurrencyHint) {
        validationErrors.push(
          `${recordLabel}: Konflik mata uang terdeteksi antara data transaksi (${rawRecordCurrency}) dan nominal (${stringAmountCurrencyHint}).`
        );
        continue;
      }

      const effectiveCurrencyContext = rawRecordCurrency || stringAmountCurrencyHint;
      const parsedFinancialResult = parseFinancialAmount(rawAmountValue, effectiveCurrencyContext);
      if (parsedFinancialResult !== null && Number.isFinite(parsedFinancialResult.amount)) {
        parsedAmount = parsedFinancialResult.amount;
        if (parsedFinancialResult.explicitCurrencyHint) {
          stringAmountCurrencyHint = parsedFinancialResult.explicitCurrencyHint.trim().toUpperCase();
        }
      }
    }

    if (parsedAmount === null || !Number.isFinite(parsedAmount) || Number.isNaN(parsedAmount)) {
      validationErrors.push(`${recordLabel}: Nominal tidak valid (${currentRecord.amount}).`);
      continue;
    }

    if (parsedAmount === 0) {
      validationErrors.push(`${recordLabel}: Nominal transaksi tidak boleh bernilai 0.`);
      continue;
    }

    if (Math.abs(parsedAmount) > MAXIMUM_SINGLE_TRANSACTION_AMOUNT) {
      validationErrors.push(
        `${recordLabel}: Nominal (${Math.abs(parsedAmount).toLocaleString('id-ID')}) melebihi batas wajar keamanan sistem.`
      );
      continue;
    }

    // Reconcile currency hints: record currency vs explicit currency parsed from amount string
    if (rawRecordCurrency && stringAmountCurrencyHint && rawRecordCurrency !== stringAmountCurrencyHint) {
      validationErrors.push(
        `${recordLabel}: Konflik mata uang terdeteksi antara data transaksi (${rawRecordCurrency}) dan nominal (${stringAmountCurrencyHint}).`
      );
      continue;
    }

    const effectiveCurrencyHint = rawRecordCurrency || stringAmountCurrencyHint;

    // Persist normalized amount and reconciled currency so downstream drafts and consumers stay normalized
    currentRecord.amount = parsedAmount;
    if (effectiveCurrencyHint) {
      currentRecord.currency = effectiveCurrencyHint;
    }

    // 2. Account ID Resolution & Validation. All applicable heuristic strategies
    // are compared before committing so conflicting interpretations fail closed.
    const rawAccountIdStr = String(currentRecord.accountHint ?? currentRecord.accountId ?? '').trim();
    const accountResolution = resolveSemanticAccountHint(rawAccountIdStr, availableAccountList);

    if (accountResolution.status !== 'RESOLVED') {
      const accountIssue: AccountResolutionIssue = {
        recordIndex,
        accountHint: rawAccountIdStr,
        reason: accountResolution.reason,
        candidates: accountResolution.candidates.map(candidate => {
          const account = availableAccountList.find(item => item.id === candidate.id);
          return account ? toAccountResolutionCandidate(account) : candidate;
        }),
      };
      accountResolutionIssues.push(accountIssue);
      entityResolutionIssues.push({
        recordIndex,
        entityType: 'ACCOUNT',
        hint: rawAccountIdStr,
        reason: accountResolution.reason,
        candidates: accountResolution.candidates,
      });
      continue;
    }

    const resolvedAccount = availableAccountList.find(account => account.id === accountResolution.id)!;
    const resolvedAccountId = accountResolution.id;

    // Currency compatibility check: explicit OCR / record currency hint must match resolved account currency
    if (effectiveCurrencyHint && resolvedAccount.currency) {
      const normalizedAccountCurrency = resolvedAccount.currency.trim().toUpperCase();
      const normalizedRecordCurrency = effectiveCurrencyHint.trim().toUpperCase();
      if (normalizedRecordCurrency !== normalizedAccountCurrency) {
        validationErrors.push(
          `${recordLabel}: Mata uang transaksi (${normalizedRecordCurrency}) berbeda dengan mata uang akun ${resolvedAccount.name} (${normalizedAccountCurrency}).`
        );
        continue;
      }
    }

    // 3. Category ID Validation (supports UUID, 1-based index number, exact name, or partial name)
    let resolvedCategoryId: string | undefined;
    const rawCategoryHint = String(currentRecord.categoryHint ?? currentRecord.categoryId ?? '').trim();
    if (rawCategoryHint) {
      const categoryResolution = resolveSemanticCategoryHint(rawCategoryHint, availableCategoryList);
      if (categoryResolution.status !== 'RESOLVED') {
        entityResolutionIssues.push({
          recordIndex,
          entityType: 'CATEGORY',
          hint: rawCategoryHint,
          reason: categoryResolution.reason,
          candidates: categoryResolution.candidates,
        });
        continue;
      }
      resolvedCategoryId = categoryResolution.id;
    }

    // 4. Record Date Validation (already normalized into immutable UTC ISO string upfront)
    let resolvedRecordDate = currentRecord.recordDate || new Date(referenceDate).toISOString();
    const parsedDateTimestamp = Date.parse(resolvedRecordDate);
    if (Number.isNaN(parsedDateTimestamp)) {
      resolvedRecordDate = new Date(referenceDate).toISOString();
    } else {
      resolvedRecordDate = new Date(parsedDateTimestamp).toISOString();
    }

    // 5. Text Sanitization & Explicit Hashtag Extraction
    let extractedTagsFromNote: string[] = [];
    let cleanedNote: string | undefined = undefined;

    if (currentRecord.note) {
      const rawNoteString = String(currentRecord.note).slice(0, 500);
      const hashtagResult = extractHashtags(rawNoteString);
      cleanedNote = hashtagResult.cleanedText.length > 0 ? hashtagResult.cleanedText : undefined;
      // AI note hashtags are cleaned from note, but only accepted as labels if they also exist
      // in the authorized explicit hashtag set derived from raw user input
      extractedTagsFromNote = hashtagResult.tags.filter(tag =>
        allowedExplicitTagSet.has(tag.toLowerCase())
      );
    }

    // Require explicit hashtags before accepting AI-provided labels
    const incomingLabels = Array.isArray(currentRecord.labels)
      ? currentRecord.labels
          .map(normalizeTagName)
          .filter(tag => allowedExplicitTagSet.has(tag.toLowerCase()))
      : [];

    // For single-record input, always union all deterministically parsed sourceUserText hashtags
    // with validated per-record labels so omission by the model never drops user-authored hashtags
    const fallbackSourceTags: string[] = [];
    if (incomingRecords.length === 1 && rawSourceHashtags && rawSourceHashtags.length > 0) {
      fallbackSourceTags.push(...rawSourceHashtags);
    }

    const combinedLabels = deduplicateTags([
      ...incomingLabels,
      ...extractedTagsFromNote,
      ...fallbackSourceTags,
    ]);

    const sanitizedCounterParty = currentRecord.counterParty
      ? String(currentRecord.counterParty).slice(0, 100).trim()
      : undefined;

    const sanitizedRecordItem: CreateRecordInputPayload = {
      accountId: resolvedAccountId,
      categoryId: resolvedCategoryId,
      amount: parsedAmount,
      recordDate: resolvedRecordDate,
      note: cleanedNote,
      counterParty: sanitizedCounterParty,
      ...(effectiveCurrencyHint ? { currency: effectiveCurrencyHint } : {}),
    };

    if (combinedLabels.length > 0) {
      sanitizedRecordItem.labels = combinedLabels;
    }

    // Incoming labelIds are always discarded at the validation boundary to prevent
    // untrusted or hallucinated IDs from bypassing name-based label resolution.

    sanitizedRecords.push(sanitizedRecordItem);
  }

  return {
    isValid:
      sanitizedRecords.length > 0 &&
      validationErrors.length === 0 &&
      accountResolutionIssues.length === 0,
    sanitizedRecords,
    validationErrors,
    accountResolutionIssues,
    entityResolutionIssues,
  };
}
