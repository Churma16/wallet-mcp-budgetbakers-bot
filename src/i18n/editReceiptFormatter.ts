import type { ClearableRecordField, RecordEditSuccessParams } from './types.js';
import { buildActionReceiptCard } from '../wallet/formatters/transactionCardBuilder.js';

/**
 * Localization configuration for record edit success receipt cards.
 */
export interface EditReceiptLocaleConfig {
  readonly header: string | ((title: string, isTransfer?: boolean) => string);
  readonly accountMoved: (from: string, to: string) => string;
  readonly clearedFieldsHeader: string;
  readonly fieldNames: Record<ClearableRecordField, string>;
}

/**
 * Formats a user-facing receipt message when a Wallet transaction is updated via shorthand edit command.
 */
export function formatEditSuccessReceipt(
  params: RecordEditSuccessParams,
  config: EditReceiptLocaleConfig
): string {
  const headerText = typeof config.header === 'function'
    ? config.header(params.transactionTitle, params.isTransfer)
    : `${config.header}\n\n${params.transactionTitle}`;

  const extraLines: string[] = [];
  if (params.movedFromAccountName) {
    extraLines.push(config.accountMoved(params.movedFromAccountName, params.accountName));
  }

  const clearedLabels = [
    ...(params.clearedFieldLabels || []),
    ...((params.clearedFields || []).map(field => config.fieldNames[field] || field)),
  ];

  if (clearedLabels.length > 0) {
    extraLines.push(`${config.clearedFieldsHeader} ${Array.from(new Set(clearedLabels)).join(', ')}`);
  }

  return buildActionReceiptCard({
    actionHeader: headerText,
    formattedAmount: params.formattedAmount,
    accountName: params.accountName,
    categoryName: params.categoryName,
    recordTimestampDisplay: params.recordTimestampDisplay,
    transactionTypeIcon: params.transactionTypeIcon,
    isTransfer: params.isTransfer,
    destinationAccountName: params.destinationAccountName,
    labels: params.labels,
    extraLines,
  });
}
