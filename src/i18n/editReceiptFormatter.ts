import type { ClearableRecordField, RecordEditSuccessParams } from './types.js';

/**
 * Localization configuration for record edit success receipt cards.
 */
export interface EditReceiptLocaleConfig {
  readonly header: string;
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
  const lines = [
    config.header,
    '',
    params.transactionTitle,
    `${params.transactionTypeIcon} ${params.formattedAmount}  •  ${params.accountName}`,
    `🏷️ ${params.categoryName}  •  ${params.recordTimestampDisplay}`,
  ];

  if (params.labels && params.labels.length > 0) {
    lines.push(`🔖 ${params.labels.map(label => `#${label.replace(/^#/, '')}`).join(' ')}`);
  }

  if (params.movedFromAccountName) {
    lines.push(config.accountMoved(params.movedFromAccountName, params.accountName));
  }

  const clearedLabels = [
    ...(params.clearedFieldLabels || []),
    ...((params.clearedFields || []).map(field => config.fieldNames[field] || field)),
  ];

  if (clearedLabels.length > 0) {
    lines.push(`${config.clearedFieldsHeader} ${Array.from(new Set(clearedLabels)).join(', ')}`);
  }

  return lines.join('\n');
}
