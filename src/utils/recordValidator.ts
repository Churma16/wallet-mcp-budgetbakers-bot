import { WalletAccountItem, WalletCategoryItem, CreateRecordInputPayload } from '../types/walletTypes.js';
import { getApplicationTimezone } from './humanResponseFormatter.js';
import {
  getTimezoneOffsetDetails,
  parseRelativeTime,
  resolveTargetLocalToUtcIso,
  ParsedRelativeTimeResult,
} from './relativeTimeParser.js';
import { extractHashtags, deduplicateTags, normalizeTagName } from './hashtagParser.js';
import { parseFinancialAmount, parseFinancialAmountString } from './financialAmountParser.js';

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
}

const MAXIMUM_RECORDS_PER_BATCH = 20;
const MAXIMUM_SINGLE_TRANSACTION_AMOUNT = 100_000_000_000; // 100 billion IDR upper limit for sanity

function toAccountResolutionCandidate(account: WalletAccountItem): AccountResolutionCandidate {
  return {
    id: account.id,
    name: account.name,
    bankAccountNumber: account.bankAccountNumber,
  };
}

function findBankAccountMatches(
  rawAccountHint: string,
  availableAccountList: WalletAccountItem[]
): WalletAccountItem[] {
  const numericDigitsOnly = rawAccountHint.replace(/\D/g, '');
  if (numericDigitsOnly.length < 4) {
    return [];
  }

  return availableAccountList.filter(account => {
    if (!account.bankAccountNumber) {
      return false;
    }

    const cleanAccountDigits = account.bankAccountNumber.replace(/\D/g, '');
    return cleanAccountDigits === numericDigitsOnly ||
      cleanAccountDigits.endsWith(numericDigitsOnly) ||
      numericDigitsOnly.endsWith(cleanAccountDigits);
  });
}

function uniqueAccountsById(accounts: WalletAccountItem[]): WalletAccountItem[] {
  const uniqueAccounts = new Map<string, WalletAccountItem>();
  for (const account of accounts) {
    uniqueAccounts.set(account.id, account);
  }
  return Array.from(uniqueAccounts.values());
}

function findAccountResolutionCandidates(
  rawAccountHint: string,
  availableAccountList: WalletAccountItem[]
): WalletAccountItem[] {
  // An exact Wallet ID is canonical and does not need heuristic interpretation.
  const exactIdMatches = availableAccountList.filter(account => account.id === rawAccountHint);
  if (exactIdMatches.length > 0) {
    return uniqueAccountsById(exactIdMatches);
  }

  const resolutionCandidates: WalletAccountItem[] = [];

  // Numeric hints may represent the 1-based account index shown to the AI/user.
  if (/^\d+$/.test(rawAccountHint)) {
    const accountIndex = Number.parseInt(rawAccountHint, 10) - 1;
    if (accountIndex >= 0 && accountIndex < availableAccountList.length) {
      resolutionCandidates.push(availableAccountList[accountIndex]);
    }
  }

  // Prefer exact-name interpretation over partial-name interpretation, but compare
  // that name interpretation with other applicable strategies before resolving.
  const normalizedAccountHint = rawAccountHint.toLowerCase();
  const exactNameMatches = availableAccountList.filter(
    account => account.name.toLowerCase() === normalizedAccountHint
  );

  if (exactNameMatches.length > 0) {
    resolutionCandidates.push(...exactNameMatches);
  } else if (rawAccountHint.length > 1) {
    resolutionCandidates.push(
      ...availableAccountList.filter(account =>
        account.name.toLowerCase().includes(normalizedAccountHint) ||
        normalizedAccountHint.includes(account.name.toLowerCase())
      )
    );
  }

  // Bank-account interpretation is evaluated alongside index/name interpretations.
  // Distinct accounts from different strategies must fail closed as ambiguous.
  resolutionCandidates.push(...findBankAccountMatches(rawAccountHint, availableAccountList));

  return uniqueAccountsById(resolutionCandidates);
}

/**
 * Validates and sanitizes financial records extracted by AI before dispatching to Wallet MCP.
 * Prevents hallucinatory account IDs, zero/infinite amounts, out-of-range values, and corrupt dates.
 */
export function validateAndSanitizeFinancialRecords(
  incomingRecords: CreateRecordInputPayload[],
  availableAccountList: WalletAccountItem[],
  availableCategoryList: WalletCategoryItem[],
  contextualUserMessage?: string,
  referenceDate: Date = new Date(),
  sourceUserTextForHashtags?: string
): FinancialRecordValidationResult {
  const validationErrors: string[] = [];
  const sanitizedRecords: CreateRecordInputPayload[] = [];
  const accountResolutionIssues: AccountResolutionIssue[] = [];

  if (!Array.isArray(incomingRecords) || incomingRecords.length === 0) {
    return {
      isValid: false,
      sanitizedRecords: [],
      validationErrors: ['Tidak ada data transaksi yang dapat divalidasi.'],
      accountResolutionIssues: [],
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
    } else if (typeof normalizedRecordDate === 'string') {
      const trimmedDateString = normalizedRecordDate.trim();
      // Only apply application-IANA target-date resolution to local timestamps that do not contain an offset
      // (e.g. 2026-07-15T11:54:00 or 2026-07-15 11:54).
      // Explicit ISO offsets (e.g. 2026-07-15T11:54:00-05:00) are treated as authoritative source information
      // and are preserved without being overwritten.
      const localIsoWithoutOffsetMatch = trimmedDateString.match(
        /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/
      );
      if (localIsoWithoutOffsetMatch) {
        const [, datePart, hourPart, minutePart] = localIsoWithoutOffsetMatch;
        try {
          normalizedRecordDate = resolveTargetLocalToUtcIso(
            datePart,
            Number.parseInt(hourPart, 10),
            Number.parseInt(minutePart, 10),
            applicationTimezone
          );
        } catch (error) {
          if (error instanceof RangeError) {
            validationErrors.push(
              `Transaksi #${recordIndex + 1}: Waktu transaksi tidak valid pada timezone ${applicationTimezone} (${trimmedDateString}).`
            );
            invalidRecordIndices.add(recordIndex);
            continue;
          }
          throw error;
        }
      }
    }

    const parsedDateTimestamp = Date.parse(normalizedRecordDate);
    if (Number.isNaN(parsedDateTimestamp)) {
      normalizedRecordDate = new Date(referenceDate).toISOString();
    } else {
      normalizedRecordDate = new Date(parsedDateTimestamp).toISOString();
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
    let parsedAmount = Number(rawAmountValue);
    let recordCurrencyHint: string | undefined =
      typeof currentRecord.currency === 'string' && currentRecord.currency.trim()
        ? currentRecord.currency.trim().toUpperCase()
        : undefined;

    if ((!Number.isFinite(parsedAmount) || Number.isNaN(parsedAmount)) && typeof rawAmountValue === 'string') {
      const parsedFinancialResult = parseFinancialAmount(rawAmountValue);
      if (parsedFinancialResult !== null && Number.isFinite(parsedFinancialResult.amount)) {
        parsedAmount = parsedFinancialResult.amount;
        if (!recordCurrencyHint && parsedFinancialResult.explicitCurrencyHint) {
          recordCurrencyHint = parsedFinancialResult.explicitCurrencyHint;
        }
      }
    }

    if (!Number.isFinite(parsedAmount) || Number.isNaN(parsedAmount)) {
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

    // 2. Account ID Resolution & Validation. All applicable heuristic strategies
    // are compared before committing so conflicting interpretations fail closed.
    const rawAccountIdStr = String(currentRecord.accountId ?? '').trim();
    const accountResolutionCandidates = findAccountResolutionCandidates(
      rawAccountIdStr,
      availableAccountList
    );

    if (accountResolutionCandidates.length !== 1) {
      if (recordCurrencyHint) {
        currentRecord.currency = recordCurrencyHint;
      }
      accountResolutionIssues.push({
        recordIndex,
        accountHint: rawAccountIdStr,
        reason: accountResolutionCandidates.length > 1 ? 'AMBIGUOUS' : 'UNRESOLVED',
        candidates: accountResolutionCandidates.map(toAccountResolutionCandidate),
      });
      continue;
    }

    const resolvedAccount = accountResolutionCandidates[0];
    const resolvedAccountId = resolvedAccount.id;

    // Currency compatibility check: explicit OCR / record currency hint must match resolved account currency
    if (recordCurrencyHint && resolvedAccount.currency) {
      const normalizedAccountCurrency = resolvedAccount.currency.trim().toUpperCase();
      const normalizedRecordCurrency = recordCurrencyHint.trim().toUpperCase();
      if (normalizedRecordCurrency !== normalizedAccountCurrency) {
        validationErrors.push(
          `${recordLabel}: Mata uang transaksi (${normalizedRecordCurrency}) berbeda dengan mata uang akun ${resolvedAccount.name} (${normalizedAccountCurrency}).`
        );
        continue;
      }
    }

    // 3. Category ID Validation (supports UUID, 1-based index number, exact name, or partial name)
    let resolvedCategoryId: string | undefined = undefined;
    if (currentRecord.categoryId) {
      const rawCategoryIdStr = String(currentRecord.categoryId).trim();

      // Strategy A: Exact UUID match
      const exactCategoryMatch = availableCategoryList.find(category => category.id === rawCategoryIdStr);
      if (exactCategoryMatch) {
        resolvedCategoryId = exactCategoryMatch.id;
      }

      // Strategy B: 1-based index number (e.g. 1, 24, "1", "24")
      if (!resolvedCategoryId && /^\d+$/.test(rawCategoryIdStr)) {
        const categoryIndex = Number.parseInt(rawCategoryIdStr, 10) - 1;
        if (categoryIndex >= 0 && categoryIndex < availableCategoryList.length) {
          resolvedCategoryId = availableCategoryList[categoryIndex].id;
        }
      }

      // Strategy C: Exact name match (case-insensitive)
      if (!resolvedCategoryId) {
        const nameCategoryMatch = availableCategoryList.find(
          category => category.name.toLowerCase() === rawCategoryIdStr.toLowerCase()
        );
        if (nameCategoryMatch) {
          resolvedCategoryId = nameCategoryMatch.id;
        }
      }

      // Strategy D: Substring / partial name match
      if (!resolvedCategoryId && rawCategoryIdStr.length > 2) {
        const partialCategoryMatch = availableCategoryList.find(
          category =>
            category.name.toLowerCase().includes(rawCategoryIdStr.toLowerCase()) ||
            rawCategoryIdStr.toLowerCase().includes(category.name.toLowerCase())
        );
        if (partialCategoryMatch) {
          resolvedCategoryId = partialCategoryMatch.id;
        }
      }
      // If still not matched, omit categoryId rather than failing the transaction with bad UUID
    }

    // 4. Record Date Validation (already normalized into immutable UTC ISO string upfront)
    let resolvedRecordDate = currentRecord.recordDate;
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
      ...(recordCurrencyHint ? { currency: recordCurrencyHint } : {}),
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
  };
}
