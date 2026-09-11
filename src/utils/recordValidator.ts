import { WalletAccountItem, WalletCategoryItem, CreateRecordInputPayload } from '../types/walletTypes.js';
import { getApplicationTimezone } from './humanResponseFormatter.js';
import { getTimezoneOffsetDetails } from '../services/ai/aiPromptBuilder.js';
import { extractHashtags, deduplicateTags, normalizeTagName } from './hashtagParser.js';

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
  availableCategoryList: WalletCategoryItem[]
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

  for (let recordIndex = 0; recordIndex < incomingRecords.length; recordIndex++) {
    const currentRecord = incomingRecords[recordIndex];
    const recordLabel = `Transaksi #${recordIndex + 1}`;

    // 1. Amount Validation
    const parsedAmount = Number(currentRecord.amount);
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
      accountResolutionIssues.push({
        recordIndex,
        accountHint: rawAccountIdStr,
        reason: accountResolutionCandidates.length > 1 ? 'AMBIGUOUS' : 'UNRESOLVED',
        candidates: accountResolutionCandidates.map(toAccountResolutionCandidate),
      });
      continue;
    }

    const resolvedAccountId = accountResolutionCandidates[0].id;

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

    // 4. Record Date Validation
    let resolvedRecordDate = currentRecord.recordDate;
    if (typeof resolvedRecordDate === 'string') {
      const trimmedDateString = resolvedRecordDate.trim();
      // If date string has no timezone offset or Z indicator (e.g. 2026-09-08T11:54:00)
      if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(trimmedDateString)) {
        const normalizedIsoDate = trimmedDateString.replace(' ', 'T');
        const applicationTimezone = getApplicationTimezone();
        const timezoneOffsetDetails = getTimezoneOffsetDetails(applicationTimezone);
        resolvedRecordDate = `${normalizedIsoDate}${timezoneOffsetDetails.formattedOffset}`;
      }
    }

    const parsedDateTimestamp = Date.parse(resolvedRecordDate);
    if (Number.isNaN(parsedDateTimestamp)) {
      resolvedRecordDate = new Date().toISOString();
    } else {
      resolvedRecordDate = new Date(parsedDateTimestamp).toISOString();
    }

    // 5. Text Sanitization & Explicit Hashtag Extraction
    let extractedTagsFromNote: string[] = [];
    let cleanedNote: string | undefined = undefined;

    if (currentRecord.note) {
      const rawNoteString = String(currentRecord.note).slice(0, 500);
      const hashtagResult = extractHashtags(rawNoteString);
      extractedTagsFromNote = hashtagResult.tags;
      cleanedNote = hashtagResult.cleanedText.length > 0 ? hashtagResult.cleanedText : undefined;
    }

    const incomingLabels = Array.isArray(currentRecord.labels)
      ? currentRecord.labels.map(normalizeTagName)
      : [];

    const combinedLabels = deduplicateTags([...incomingLabels, ...extractedTagsFromNote]);

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
    };

    if (combinedLabels.length > 0) {
      sanitizedRecordItem.labels = combinedLabels;
    }
    if (Array.isArray(currentRecord.labelIds) && currentRecord.labelIds.length > 0) {
      sanitizedRecordItem.labelIds = currentRecord.labelIds;
    }

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
