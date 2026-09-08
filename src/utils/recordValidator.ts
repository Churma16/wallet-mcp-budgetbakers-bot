import { WalletAccountItem, WalletCategoryItem, CreateRecordInputPayload } from '../types/walletTypes.js';
import { getApplicationTimezone } from './humanResponseFormatter.js';
import { getTimezoneOffsetDetails } from '../services/ai/aiPromptBuilder.js';

export interface FinancialRecordValidationResult {
  isValid: boolean;
  sanitizedRecords: CreateRecordInputPayload[];
  validationErrors: string[];
}

const MAXIMUM_RECORDS_PER_BATCH = 20;
const MAXIMUM_SINGLE_TRANSACTION_AMOUNT = 100_000_000_000; // 100 billion IDR upper limit for sanity

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

  if (!Array.isArray(incomingRecords) || incomingRecords.length === 0) {
    return {
      isValid: false,
      sanitizedRecords: [],
      validationErrors: ['Tidak ada data transaksi yang dapat divalidasi.'],
    };
  }

  if (incomingRecords.length > MAXIMUM_RECORDS_PER_BATCH) {
    return {
      isValid: false,
      sanitizedRecords: [],
      validationErrors: [
        `Jumlah transaksi (${incomingRecords.length}) melebihi batas wajar (${MAXIMUM_RECORDS_PER_BATCH} entri per pesan).`,
      ],
    };
  }

  for (let recordIndex = 0; recordIndex < incomingRecords.length; recordIndex++) {
    const currentRecord = incomingRecords[recordIndex];
    const recordLabel = `Transaksi #${recordIndex + 1}`;

    // 1. Amount Validation
    const parsedAmount = Number(currentRecord.amount);
    if (!Number.isFinite(parsedAmount) || isNaN(parsedAmount)) {
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

    // 2. Account ID Resolution & Validation (supports UUID, 1-based index number, exact name, or partial name)
    let resolvedAccountId: string | undefined = undefined;
    const rawAccountIdStr = String(currentRecord.accountId ?? '').trim();

    // Strategy A: Exact UUID match
    const exactAccountMatch = availableAccountList.find(account => account.id === rawAccountIdStr);
    if (exactAccountMatch) {
      resolvedAccountId = exactAccountMatch.id;
    }

    // Strategy B: 1-based index number (e.g. 1, 2, "1", "2")
    if (!resolvedAccountId && /^\d+$/.test(rawAccountIdStr)) {
      const accountIndex = parseInt(rawAccountIdStr, 10) - 1;
      if (accountIndex >= 0 && accountIndex < availableAccountList.length) {
        resolvedAccountId = availableAccountList[accountIndex].id;
      }
    }

    // Strategy C: Exact name match (case-insensitive)
    if (!resolvedAccountId) {
      const nameAccountMatch = availableAccountList.find(
        account => account.name.toLowerCase() === rawAccountIdStr.toLowerCase()
      );
      if (nameAccountMatch) {
        resolvedAccountId = nameAccountMatch.id;
      }
    }

    // Strategy D: Substring / partial name match
    if (!resolvedAccountId && rawAccountIdStr.length > 1) {
      const partialAccountMatch = availableAccountList.find(
        account =>
          account.name.toLowerCase().includes(rawAccountIdStr.toLowerCase()) ||
          rawAccountIdStr.toLowerCase().includes(account.name.toLowerCase())
      );
      if (partialAccountMatch) {
        resolvedAccountId = partialAccountMatch.id;
      }
    }

    // Strategy E: Bank account number match (exact or digit-only matching for account numbers with >= 4 digits)
    if (!resolvedAccountId && rawAccountIdStr.length >= 4) {
      const numericDigitsOnly = rawAccountIdStr.replace(/\D/g, '');
      if (numericDigitsOnly.length >= 4) {
        const bankAccountMatch = availableAccountList.find(account => {
          if (!account.bankAccountNumber) {
            return false;
          }
          const cleanAccountDigits = account.bankAccountNumber.replace(/\D/g, '');
          return cleanAccountDigits === numericDigitsOnly ||
            cleanAccountDigits.endsWith(numericDigitsOnly) ||
            numericDigitsOnly.endsWith(cleanAccountDigits);
        });
        if (bankAccountMatch) {
          resolvedAccountId = bankAccountMatch.id;
        }
      }
    }

    // Fallback: Default to first account or error if no accounts
    if (!resolvedAccountId) {
      if (availableAccountList.length > 0) {
        resolvedAccountId = availableAccountList[0].id;
      } else {
        validationErrors.push(`${recordLabel}: ID Akun tidak ditemukan dan belum ada akun terdaftar di Wallet.`);
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
        const categoryIndex = parseInt(rawCategoryIdStr, 10) - 1;
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
    if (isNaN(parsedDateTimestamp)) {
      resolvedRecordDate = new Date().toISOString();
    } else {
      resolvedRecordDate = new Date(parsedDateTimestamp).toISOString();
    }

    // 5. Text Sanitization
    const sanitizedNote = currentRecord.note
      ? String(currentRecord.note).slice(0, 500).trim()
      : undefined;

    const sanitizedCounterParty = currentRecord.counterParty
      ? String(currentRecord.counterParty).slice(0, 100).trim()
      : undefined;

    sanitizedRecords.push({
      accountId: resolvedAccountId,
      categoryId: resolvedCategoryId,
      amount: parsedAmount,
      recordDate: resolvedRecordDate,
      note: sanitizedNote,
      counterParty: sanitizedCounterParty,
    });
  }

  return {
    isValid: sanitizedRecords.length > 0 && validationErrors.length === 0,
    sanitizedRecords,
    validationErrors,
  };
}
