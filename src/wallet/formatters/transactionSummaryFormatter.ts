import { TransactionSummaryResult } from '../types.js';
import { getActiveLanguage, getDictionary, SupportedLanguage } from '../../i18n/index.js';
import { formatCurrencyAmount } from './humanResponseFormatter.js';

function formatSignedAmount(
  amount: number,
  currency: string,
  languageCode: SupportedLanguage
): string {
  const formattedAmount = formatCurrencyAmount(amount, currency, languageCode);
  if (amount > 0) {
    return `+${formattedAmount}`;
  }
  if (amount < 0) {
    return `-${formattedAmount}`;
  }
  return formattedAmount;
}

function buildFilterSummary(
  summaryResult: TransactionSummaryResult,
  languageCode: SupportedLanguage
): string | null {
  const appliedFilters = summaryResult.appliedFilters;
  if (!appliedFilters) {
    return null;
  }

  const filterParts: string[] = [];
  if (appliedFilters.dateRange?.label) {
    filterParts.push(appliedFilters.dateRange.label);
  }
  if (appliedFilters.account?.name) {
    filterParts.push(
      languageCode === 'en'
        ? `account: ${appliedFilters.account.name}`
        : `akun: ${appliedFilters.account.name}`
    );
  }
  if (appliedFilters.category?.name) {
    filterParts.push(
      languageCode === 'en'
        ? `category: ${appliedFilters.category.name}`
        : `kategori: ${appliedFilters.category.name}`
    );
  } else if (appliedFilters.categoryGroup) {
    filterParts.push(
      languageCode === 'en'
        ? `category: ${appliedFilters.categoryGroup}`
        : `kategori: ${appliedFilters.categoryGroup}`
    );
  }
  if (appliedFilters.recordType) {
    filterParts.push(
      appliedFilters.recordType === 'expense'
        ? (languageCode === 'en' ? 'expenses' : 'pengeluaran')
        : (languageCode === 'en' ? 'income' : 'pemasukan')
    );
  }

  if (filterParts.length === 0) {
    return null;
  }

  return filterParts.join(' • ');
}

export function formatTransactionSummaryMessage(
  summaryResult: TransactionSummaryResult,
  languageCode?: SupportedLanguage
): string {
  const activeLanguage = languageCode || getActiveLanguage();
  const dictionary = getDictionary(activeLanguage);

  if (summaryResult.unresolvedFilters && summaryResult.unresolvedFilters.length > 0) {
    return dictionary.history.unresolvedFilters(summaryResult.unresolvedFilters);
  }

  const isEnglish = activeLanguage === 'en';
  const header = isEnglish ? '📊 *Transaction Summary*' : '📊 *Ringkasan Transaksi*';
  const messageParts: string[] = [header];
  const filterSummary = buildFilterSummary(summaryResult, activeLanguage);
  const filteredRecordType = summaryResult.appliedFilters?.recordType;
  if (filterSummary) {
    messageParts.push(`_${filterSummary}_`);
  }

  if (summaryResult.transactionCount === 0) {
    messageParts.push('');
    messageParts.push(
      summaryResult.excludedTransferCount > 0
        ? (isEnglish
            ? 'No income or expense transactions match these filters. Transfer records are excluded from summary totals.'
            : 'Tidak ada transaksi pemasukan atau pengeluaran yang cocok. Transaksi transfer tidak dihitung dalam total ringkasan.')
        : (isEnglish
            ? 'No transactions match these filters.'
            : 'Tidak ada transaksi yang cocok dengan filter ini.')
    );

    if (summaryResult.transferCountUnknown) {
      messageParts.push(
        isEnglish
          ? '_Transfer count could not be verified._'
          : '_Jumlah transfer tidak dapat diverifikasi._'
      );
    }

    if (!summaryResult.isComplete) {
      messageParts.push('');
      messageParts.push(
        isEnglish
          ? '⚠️ _This summary is partial because the upstream history could not be scanned completely._'
          : '⚠️ _Ringkasan ini bersifat parsial karena riwayat upstream tidak dapat dipindai sepenuhnya._'
      );
    }

    return messageParts.join('\n');
  }

  messageParts.push('');
  for (const currencyTotals of summaryResult.totals) {
    if (summaryResult.isMultiCurrency) {
      messageParts.push(`*${currencyTotals.currency}*`);
    }

    const incomeLabel = isEnglish ? 'Income' : 'Pemasukan';
    const expenseLabel = isEnglish ? 'Expenses' : 'Pengeluaran';
    const netLabel = 'Net';

    if (filteredRecordType !== 'expense') {
      messageParts.push(`💰 ${incomeLabel}: *${formatCurrencyAmount(currencyTotals.income, currencyTotals.currency, activeLanguage)}*`);
    }
    if (filteredRecordType !== 'income') {
      messageParts.push(`💸 ${expenseLabel}: *${formatCurrencyAmount(currencyTotals.expense, currencyTotals.currency, activeLanguage)}*`);
    }
    if (!filteredRecordType) {
      messageParts.push(`🧮 ${netLabel}: *${formatSignedAmount(currencyTotals.net, currencyTotals.currency, activeLanguage)}*`);
    }

    if (summaryResult.isMultiCurrency) {
      messageParts.push('');
    }
  }

  if (summaryResult.isMultiCurrency) {
    messageParts.push(
      isEnglish
        ? '_Currencies are shown separately. No cross-currency total is calculated._'
        : '_Setiap mata uang ditampilkan terpisah. Tidak ada total lintas mata uang yang dihitung._'
    );
  }

  if (summaryResult.transferCountUnknown) {
    messageParts.push(
      isEnglish
        ? '_Transfer count could not be verified._'
        : '_Jumlah transfer tidak dapat diverifikasi._'
    );
  }

  if (summaryResult.groupBy !== 'none' && summaryResult.breakdown.length > 0) {
    const isIncomeOnly = filteredRecordType === 'income';
    const isCategory = summaryResult.groupBy === 'category';

    const relevantItems = isCategory
      ? isIncomeOnly
        ? summaryResult.breakdown.filter(item => (item.totals[0]?.income || 0) > 0).slice(0, 5)
        : summaryResult.breakdown.filter(item => (item.totals[0]?.expense || 0) > 0).slice(0, 5)
      : summaryResult.breakdown.slice(0, 5);

    if (relevantItems.length > 0) {
      messageParts.push('');
      const breakdownTitle = isCategory
        ? isIncomeOnly
          ? (isEnglish ? '*Top Income:*' : '*Top Pemasukan:*')
          : (isEnglish ? '*Top Expenses:*' : '*Top Pengeluaran:*')
        : (isEnglish ? '*By Account:*' : '*Per Akun:*');
      messageParts.push(breakdownTitle);

      relevantItems.forEach((breakdownItem, itemIndex) => {
        const fallbackName = isCategory
          ? (isEnglish ? 'Uncategorized' : 'Tanpa Kategori')
          : (isEnglish ? 'Unknown Account' : 'Akun Tidak Diketahui');
        const displayName = breakdownItem.name || fallbackName;

        for (const currencyTotals of breakdownItem.totals) {
          const currencyPrefix = summaryResult.isMultiCurrency ? `${currencyTotals.currency} ` : '';
          const targetAmount = isIncomeOnly ? currencyTotals.income : currencyTotals.expense;
          const formattedAmount = formatCurrencyAmount(targetAmount, currencyTotals.currency, activeLanguage);

          if (isCategory) {
            messageParts.push(`${itemIndex + 1}. ${displayName}: *${currencyPrefix}${formattedAmount}*`);
          } else {
            const expenseText = formatCurrencyAmount(currencyTotals.expense, currencyTotals.currency, activeLanguage);
            const incomeText = formatCurrencyAmount(currencyTotals.income, currencyTotals.currency, activeLanguage);
            if (filteredRecordType === 'expense') {
              messageParts.push(`${itemIndex + 1}. ${displayName}: *${currencyPrefix}${expenseText}*`);
            } else if (filteredRecordType === 'income') {
              messageParts.push(`${itemIndex + 1}. ${displayName}: *${currencyPrefix}${incomeText}*`);
            } else {
              messageParts.push(`${itemIndex + 1}. ${displayName}: *${currencyPrefix}${expenseText}* • *${currencyPrefix}${incomeText}*`);
            }
          }
        }
      });
    }
  }

  if (!summaryResult.isComplete) {
    messageParts.push('');
    messageParts.push(
      isEnglish
        ? '⚠️ _This summary is partial because the upstream history could not be scanned completely._'
        : '⚠️ _Ringkasan ini bersifat parsial karena riwayat upstream tidak dapat dipindai sepenuhnya._'
    );
  }

  return messageParts.join('\n');
}
