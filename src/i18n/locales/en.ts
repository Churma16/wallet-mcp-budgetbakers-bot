import {
  ResponseDictionary,
  RecordMessageParams,
  MultipleRecordsItemParams,
  PendingEmailNotificationParams,
  PendingConfirmationSuccessParams,
  PendingBulkItemParams,
  PendingCancellationParams,
  type TransactionSortOrder,
} from '../types.js';

export const englishDictionary: ResponseDictionary = {
  languageCode: 'en',
  localeIdentifier: 'en-US',
  timeZoneLabel: 'WIB',

  labels: {
    expense: 'Expense',
    income: 'Income',
    transfer: 'Transfer / Top-Up',
    defaultAccount: 'Account',
    defaultCategory: 'General',
    total: 'Total',
    remaining: 'remaining',
    from: 'From',
    to: 'To',
  },

  records: {
    singleSuccess(params: RecordMessageParams): string {
      const labelLine = params.labels && params.labels.length > 0
        ? `\n🔖 ${params.labels.map(label => `#${label}`).join(' ')}`
        : '';
      return [
        `✅ *${params.transactionTitle}* recorded successfully!`,
        '',
        `${params.transactionTypeIcon} ${params.formattedAmount}  •  ${params.accountName}`,
        `🏷️ ${params.categoryName}  •  ${params.recordTimestampDisplay}${labelLine}`,
      ].join('\n');
    },

    multipleSuccessHeader(totalRecordsCount: number, currentTimestamp: string): string {
      return `✅ *${totalRecordsCount} transactions* recorded successfully! (${currentTimestamp})`;
    },

    multipleRecordItem(params: MultipleRecordsItemParams): string {
      const labelSuffix = params.labels && params.labels.length > 0
        ? `  •  🔖 ${params.labels.map(label => `#${label}`).join(' ')}`
        : '';
      return [
        `${params.itemIndex + 1}. ${params.transactionTypeIcon} ${params.transactionDescription} — *${params.formattedAmount}* from ${params.accountName}`,
        `   🏷️ ${params.categoryName}  •  ${params.recordTimestampDisplay}${labelSuffix}`,
      ].join('\n');
    },
  },

  balance: {
    header(currentTimestamp: string): string {
      return `📊 *Account Balances* (${currentTimestamp})`;
    },
    emptyState: 'No connected accounts found.',
    grandTotal(formattedTotal: string): string {
      return `*Total: ${formattedTotal}*`;
    },
    notAvailable: 'N/A',
  },

  budget: {
    header(currentTimestamp: string): string {
      return `📈 *Budget Status* (${currentTimestamp})`;
    },
    emptyState: 'No active budgets found.',
    budgetItem(name: string, spent: string, limit: string, remaining: string): string {
      return `• *${name}*: ${spent} / ${limit} _(${remaining} left)_`;
    },
    budgetOverspentItem(name: string, spent: string, limit: string, overspent: string): string {
      return `• *${name}*: ${spent} / ${limit} ⚠️ _(${overspent} over)_`;
    },
  },

  history: {
    header(page: number, totalPages: number, displayedCount: number, totalCount: number, sortOrderLabel: string): string {
      const sortSuffix = sortOrderLabel ? ` [${sortOrderLabel}]` : '';
      return `📋 *Transaction History* (Page ${page}/${totalPages} • ${displayedCount} of ${totalCount})${sortSuffix}`;
    },
    emptyState: 'No transactions recorded yet.',
    outOfBounds(totalCount: number): string {
      return `This page exceeds available transactions (Total: ${totalCount} transactions).`;
    },
    navigationHint(
      nextPage: number,
      options?: { limit?: number; sort?: TransactionSortOrder }
    ): string {
      const commandParts = ['history'];
      if (options?.limit && options.limit !== 10) {
        commandParts.push(String(options.limit));
      }
      commandParts.push(`page ${nextPage}`);
      if (options?.sort === 'oldest') {
        commandParts.push('oldest');
      }
      return `_Type *${commandParts.join(' ')}* for the next page._`;
    },
    sortNewest: 'Newest',
    sortOldest: 'Oldest',
  },

  emailPending: {
    formatNotification(params: PendingEmailNotificationParams): string {
      const lines = [
        `📩 *New Email Transaction Detected (#${params.ticketId})*`,
        `🏦 *Source:* ${params.bankDisplayName}`,
        `${params.typeIcon} *Amount:* ${params.formattedAmount} (${params.typeLabel})`,
      ];

      if (params.typeLabel.includes('Transfer') && params.destinationAccountNameHint) {
        lines.push(`🎯 *Destination:* ${params.destinationAccountNameHint}`);
      } else if (params.counterParty) {
        lines.push(`🏪 *Merchant/Party:* ${params.counterParty}`);
      }

      if (params.matchedCategoryName) {
        lines.push(`📂 *Category:* ${params.matchedCategoryName}`);
      }

      if (params.accountNameHint) {
        lines.push(`💳 *Wallet Account:* ${params.accountNameHint}`);
      }

      lines.push(`🕒 *Time:* ${params.formattedTime}`);

      if (params.referenceNumber) {
        lines.push(`🔢 *Ref ID:* \`${params.referenceNumber}\``);
      }

      lines.push('');
      if (params.totalPendingCount > 1) {
        lines.push(`_There are ${params.totalPendingCount} transactions waiting for confirmation._`);
        lines.push(`• Reply *Yes ${params.ticketId}* to record this ticket`);
        lines.push(`• Reply *Yes all* to record all tickets`);
        lines.push(`• Reply *Cancel ${params.ticketId}* to cancel`);
      } else {
        lines.push('• Reply *Yes* or *Record* to save to Wallet');
        lines.push('• Reply *Cancel* to ignore');
      }

      return lines.join('\n');
    },
  },

  confirmation: {
    singleSuccess(params: PendingConfirmationSuccessParams): string {
      if (params.isTransfer) {
        return [
          `✅ *Transfer Recorded to Wallet!* (#${params.ticketId})`,
          `🔄 ${params.formattedAmount}`,
          `💳 From: ${params.accountNameHint}${params.destinationAccountNameHint ? ` ➔ ${params.destinationAccountNameHint}` : ''}`,
          `_(${params.formattedTime})_`,
        ].join('\n');
      }

      const lines = [
        `✅ *Transaction Recorded to Wallet!* (#${params.ticketId})`,
        `${params.icon || '💸'} ${params.merchantOrNote || 'Transaction'} — ${params.formattedAmount}`,
      ];

      const metaParts: string[] = [];
      if (params.accountNameHint) {
        metaParts.push(`💳 ${params.accountNameHint}`);
      }
      if (params.matchedCategoryName) {
        metaParts.push(`📂 ${params.matchedCategoryName}`);
      }
      if (metaParts.length > 0) {
        lines.push(metaParts.join(' • '));
      }

      lines.push(`_(${params.formattedTime})_`);
      return lines.join('\n');
    },

    bulkSuccess(items: PendingBulkItemParams[], currentTimestamp: string): string {
      const lines = [
        `✅ *${items.length} Transactions Successfully Recorded to Wallet!*`,
        '',
      ];

      for (const item of items) {
        lines.push(`• [#${item.ticketId}] ${item.title}: ${item.formattedAmount} (${item.accountNameHint || 'Account'})`);
      }

      lines.push('');
      lines.push(`_(${currentTimestamp})_`);
      return lines.join('\n');
    },

    cancellation(params: PendingCancellationParams): string {
      if (params.isBulk) {
        return `❌ *${params.count} Transactions Cancelled*\nAll pending transactions have been discarded and were not recorded to Wallet.`;
      }
      return `❌ *Transaction #${params.ticketId} Cancelled*\nTransaction "${params.title}" (${params.formattedAmount}) was not recorded to Wallet.`;
    },
  },

  help: {
    welcomeGuidance: '👋 Hello! Send your expenses (e.g. "Lunch 25k using Cash") or receipt photos to record them to Wallet.',
    quickCommandsTitle: '*Quick Commands (0 AI Tokens):*',
    commandBalance: '• *Balance* / *Check Balance*: Check all account balances',
    commandBudget: '• *Budget* / *Check Budget*: Check budget limit status',
    commandHistory: '• *History*: Check recent transaction history',
    commandMenu: '• *Menu* / *Help*: Show this guidance',
  },

  errors: {
    aiBusy(timestampString: string): string {
      return [
        '⚠️ AI service is currently busy, please try again in a few seconds!',
        `_(${timestampString})_`,
      ].join('\n');
    },
    schemaValidation(timestampString: string): string {
      return [
        '⚠️ Transaction not saved yet, data format was unclear.',
        'Please resend with clearer details, e.g.: _"Lunch 35k with Gopay"_\n_(${timestampString})_',
      ].join('\n');
    },
    networkConnection(timestampString: string): string {
      return [
        '⚠️ Server connection issue, please try again!',
        `_(${timestampString})_`,
      ].join('\n');
    },
    generic(timestampString: string): string {
      return [
        '⚠️ An issue occurred while processing your message.',
        'Details have been logged in the system for review.',
        `_(${timestampString})_`,
      ].join('\n');
    },
    validationRejected(errorMessage: string): string {
      return `⚠️ Transaction could not be saved due to invalid data:\n${errorMessage}`;
    },
    accountResolutionUnresolved(recordNumber: number, accountHint: string): string {
      const displayHint = accountHint || '(empty)';
      return `Transaction #${recordNumber}: Account "${displayHint}" could not be resolved reliably.`;
    },
    accountResolutionAmbiguous(recordNumber: number, accountHint: string, candidateNames: string[]): string {
      const displayHint = accountHint || '(empty)';
      return candidateNames.length > 0
        ? `Transaction #${recordNumber}: Account "${displayHint}" is ambiguous. Candidates: ${candidateNames.join(', ')}.`
        : `Transaction #${recordNumber}: Account "${displayHint}" is ambiguous and cannot be selected safely.`;
    },
    accountResolutionFallback: 'The transaction account could not be determined safely.',
  },
};
