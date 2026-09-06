import { WalletAccountItem, WalletCategoryItem, CreateRecordInputPayload } from '../types/walletTypes.js';

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

    // 2. Account ID Resolution & Validation
    let resolvedAccountId = currentRecord.accountId;
    const exactAccountMatch = availableAccountList.find(account => account.id === resolvedAccountId);

    if (!exactAccountMatch) {
      // Check if the AI returned the account name instead of the UUID
      const nameAccountMatch = availableAccountList.find(
        account => account.name.toLowerCase() === String(currentRecord.accountId || '').toLowerCase()
      );

      if (nameAccountMatch) {
        resolvedAccountId = nameAccountMatch.id;
      } else if (availableAccountList.length > 0) {
        // Fallback to first available account (e.g. primary cash or bank account)
        resolvedAccountId = availableAccountList[0].id;
      } else {
        validationErrors.push(`${recordLabel}: ID Akun tidak ditemukan dan belum ada akun terdaftar di Wallet.`);
        continue;
      }
    }

    // 3. Category ID Validation (optional field)
    let resolvedCategoryId: string | undefined = undefined;
    if (currentRecord.categoryId) {
      const categoryMatch = availableCategoryList.find(
        category =>
          category.id === currentRecord.categoryId ||
          category.name.toLowerCase() === String(currentRecord.categoryId).toLowerCase()
      );

      if (categoryMatch) {
        resolvedCategoryId = categoryMatch.id;
      }
      // If hallucinated or non-existent, omit categoryId rather than failing the transaction with bad UUID
    }

    // 4. Record Date Validation
    let resolvedRecordDate = currentRecord.recordDate;
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
