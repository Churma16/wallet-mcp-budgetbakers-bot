/**
 * Centralized Transaction Card Builder Engine
 *
 * Provides a single source of truth for constructing unified transaction cards
 * across manual recording, pending confirmations, retroactive enrichments,
 * correlation advisories, edits, and deletions.
 */

export interface ActionReceiptCardParams {
  actionHeader: string;
  formattedAmount: string;
  accountName: string;
  categoryName?: string;
  recordTimestampDisplay: string;
  transactionTypeIcon?: string;
  isTransfer?: boolean;
  destinationAccountName?: string;
  labels?: string[];
  extraLines?: string[];
}

/**
 * Builds a standardized receipt card for any completed transaction action
 * (recorded, edited, deleted, duplicate, or retroactively enriched).
 */
export function buildActionReceiptCard(params: ActionReceiptCardParams): string {
  if (params.isTransfer) {
    const route = params.destinationAccountName
      ? `${params.accountName} ➔ ${params.destinationAccountName}`
      : params.accountName;

    const lines = [
      params.actionHeader,
      '',
      `🔁 ${params.formattedAmount}`,
      `💳 ${route}`,
      `⏰ ${params.recordTimestampDisplay}`,
    ];

    if (params.labels && params.labels.length > 0) {
      lines.push(`🔖 ${params.labels.map(label => `#${label.replace(/^#/, '')}`).join(' ')}`);
    }

    if (params.extraLines && params.extraLines.length > 0) {
      lines.push(...params.extraLines);
    }

    return lines.join('\n');
  }

  const labelLine = params.labels && params.labels.length > 0
    ? `\n🔖 ${params.labels.map(label => `#${label.replace(/^#/, '')}`).join(' ')}`
    : '';

  const lines = [
    params.actionHeader,
    '',
    `${params.transactionTypeIcon || '💸'} ${params.formattedAmount}  •  ${params.accountName}`,
    `🏷️ ${params.categoryName || 'Umum'}  •  ${params.recordTimestampDisplay}${labelLine}`,
  ];

  if (params.extraLines && params.extraLines.length > 0) {
    lines.push(...params.extraLines);
  }

  return lines.join('\n');
}

export interface ActionPromptCardParams {
  headline: string;
  formattedAmount: string;
  accountNameHint?: string;
  defaultAccountLabel?: string;
  merchant?: string;
  categoryName?: string;
  defaultCategoryLabel?: string;
  formattedTime: string;
  note?: string;
  isTransfer?: boolean;
  destinationAccountNameHint?: string;
  isBankSyncedAccount?: boolean;
  bankSyncedNotice?: string;
  promptBody: string;
  footerCue?: string;
}

/**
 * Builds a standardized action prompt card for pending transactions or drafts
 * awaiting user confirmation or clarification.
 */
export function buildActionPromptCard(params: ActionPromptCardParams): string {
  if (params.isTransfer) {
    const route = params.destinationAccountNameHint
      ? `${params.accountNameHint || params.defaultAccountLabel || 'Akun'} ➔ ${params.destinationAccountNameHint}`
      : (params.accountNameHint || params.defaultAccountLabel || 'Akun');

    const lines = [
      params.headline,
      '',
      `🔁 ${params.formattedAmount}`,
      `💳 ${route}`,
      `⏰ ${params.formattedTime}`,
      '',
      params.promptBody,
    ];

    if (params.footerCue) {
      lines.push(params.footerCue);
    }

    return lines.join('\n');
  }

  const account = params.accountNameHint || params.defaultAccountLabel || 'Akun';
  const category = params.categoryName || params.defaultCategoryLabel || 'Umum';

  const lines = [
    params.headline,
    '',
    `${params.formattedAmount} • ${account}`,
  ];

  if (params.merchant) {
    lines.push(`🏪 ${params.merchant}`);
  }

  lines.push(`🏷️ ${category} • ${params.formattedTime}`);

  if (params.note && params.note !== params.merchant) {
    lines.push(`📝 ${params.note}`);
  }

  if (params.isBankSyncedAccount && params.bankSyncedNotice) {
    lines.push(params.bankSyncedNotice);
  }

  lines.push('', params.promptBody);

  if (params.footerCue) {
    lines.push(params.footerCue);
  }

  return lines.join('\n');
}
