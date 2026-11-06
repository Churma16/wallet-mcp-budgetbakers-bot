import { formatEditSuccessReceipt, type EditReceiptLocaleConfig } from '../editReceiptFormatter.js';
import {
  ResponseDictionary,
  RecordMessageParams,
  RecordEditSuccessParams,
  RecordDeleteSuccessParams,
  MultipleRecordsItemParams,
  PendingEmailNotificationParams,
  PendingConfirmationPromptParams,
  PendingConfirmationSuccessParams,
  PendingBulkItemParams,
  PendingCancellationParams,
  type TransactionSortOrder,
  type UnresolvedFilterIssue,
} from '../types.js';

export function formatPendingConfirmationPromptEn(params: PendingConfirmationPromptParams): string {
  const lines: string[] = ['Record this transaction?'];
  if (params.totalPendingCount > 1) {
    lines.push(`• Reply *Yes ${params.ticketId}* (or *Yes all*)`);
    lines.push(`• Reply *Yes ${params.ticketId}: n:<note> c:<category> t:<tag> m:<merchant> acc:<account>*`);
    lines.push(`• Reply *Cancel ${params.ticketId}*`);
    const otherCount = params.totalPendingCount - 1;
    lines.push('');
    lines.push(`_There is ${otherCount} other transaction waiting for confirmation._`);
  } else {
    lines.push(`• Reply *Yes* or *Record* (or *Yes ${params.ticketId}*)`);
    lines.push(`• Reply *Yes: n:<note> c:<category> t:<tag> m:<merchant> acc:<account>*`);
    lines.push(`• Reply *Cancel* or *Ignore* (or *Cancel ${params.ticketId}*)`);
  }
  return lines.join('\n');
}


const englishEditReceiptConfig: EditReceiptLocaleConfig = {
  header: (title: string, isTransfer?: boolean) =>
    isTransfer ? '✅ *Transfer updated successfully!*' : `✅ *${title}* updated successfully!`,
  accountMoved: (from, to) => `🏦 Account moved from: ${from} ➔ ${to}`,
  clearedFieldsHeader: '🧹 Cleared fields:',
  fieldNames: {
    note: 'Note',
    labelIds: 'Tags / Labels',
    counterParty: 'Merchant / Payee',
    categoryId: 'Category',
    transfer: 'Transfer Link',
    place: 'Place',
  },
};

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
    transferSuccess: 'Transfer recorded successfully!',
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

    editSuccess(params: RecordEditSuccessParams): string {
      return formatEditSuccessReceipt(params, englishEditReceiptConfig);
    },

    deleteSuccess(params: RecordDeleteSuccessParams): string {
      if (params.isTransfer) {
        const route = params.destinationAccountName
          ? `${params.accountName} ➔ ${params.destinationAccountName}`
          : params.accountName;
        return [
          `🗑️ *Transfer deleted successfully!*`,
          '',
          `🔁 ${params.formattedAmount}`,
          `💳 ${route}`,
          `⏰ ${params.recordTimestampDisplay}`,
        ].join('\n');
      }

      const labelLine = params.labels && params.labels.length > 0
        ? `\n🔖 ${params.labels.map(label => `#${label.replace(/^#/, '')}`).join(' ')}`
        : '';

      return [
        `🗑️ *${params.transactionTitle}* deleted successfully!`,
        '',
        `${params.transactionTypeIcon} ${params.formattedAmount}  •  ${params.accountName}`,
        `🏷️ ${params.categoryName}  •  ${params.recordTimestampDisplay}${labelLine}`,
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
    header(
      page: number,
      totalPages?: number,
      displayedCount?: number,
      totalCount?: number,
      sortOrderLabel?: string,
      filterSummary?: string
    ): string {
      const pageInfo = typeof totalPages === 'number' ? `Page ${page}/${totalPages}` : `Page ${page}`;
      const countLabel = displayedCount === 1 ? 'item' : 'items';
      const countInfo = typeof displayedCount === 'number' && displayedCount > 0
        ? ` • ${displayedCount} ${countLabel}`
        : '';
      const sortSuffix = sortOrderLabel ? ` [${sortOrderLabel}]` : '';
      const filterSuffix = filterSummary ? ` [${filterSummary}]` : '';
      return `📋 *Transaction History*\n${pageInfo}${countInfo}${sortSuffix}${filterSuffix}`;
    },
    emptyState: 'No transactions recorded yet.',
    emptyFilteredState(filterSummary: string): string {
      return `No transactions match the filter [${filterSummary}].`;
    },
    unresolvedFilters(issues: UnresolvedFilterIssue[]): string {
      const issueLines = issues.map(issue => {
        if (issue.filterKey === 'account') {
          if (issue.reason === 'NOT_FOUND') {
            return `• Account "${issue.rawValue}" was not found in your Wallet accounts list.`;
          }
          if (issue.reason === 'UNRESOLVED' || issue.reason === 'AMBIGUOUS') {
            if (issue.subType === 'bank_account' && issue.candidates && issue.candidates.length > 0) {
              return `• Bank account number "${issue.rawValue}" is ambiguous. Candidates: ${issue.candidates.join(', ')}.`;
            }
            if (issue.candidates && issue.candidates.length > 0) {
              return `• Account "${issue.rawValue}" is ambiguous. Candidates: ${issue.candidates.join(', ')}.`;
            }
            return `• Account "${issue.rawValue}" is ambiguous. Multiple accounts found with the same name.`;
          }
        }
        if (issue.filterKey === 'category') {
          if (issue.reason === 'NOT_FOUND') {
            return `• Category "${issue.rawValue}" was not found in your Wallet categories list.`;
          }
          if (issue.reason === 'UNSUPPORTED') {
            return `• Category group "${issue.rawValue}" is not supported by Wallet.`;
          }
          if (issue.reason === 'UNRESOLVED' || issue.reason === 'AMBIGUOUS') {
            if (issue.candidates && issue.candidates.length > 0) {
              return `• Category "${issue.rawValue}" is ambiguous. Candidates: ${issue.candidates.join(', ')}.`;
            }
            return `• Category "${issue.rawValue}" is ambiguous. Multiple categories found with the same name.`;
          }
        }
        if (issue.filterKey === 'recordType') {
          return `• Transaction type "${issue.rawValue}" is invalid. Use "expense" or "income".`;
        }
        if (issue.filterKey === 'dateRange') {
          if (issue.reason === 'INVALID_RANGE') {
            return `• Invalid date range: start boundary cannot be greater than end boundary.`;
          }
          if (issue.reason === 'INVALID_FORMAT') {
            if (issue.subType === 'operator_prefix') {
              return `• Date filter format "${issue.rawValue}" is invalid. Use operator prefix: eq., gt., gte., lt., or lte.`;
            }
            return `• Date "${issue.rawValue}" is invalid or not a valid calendar date.`;
          }
        }
        if (issue.filterKey === 'searchQuery') {
          if (issue.reason === 'UNSUPPORTED') {
            return `• Text search is not supported by the upstream data source.`;
          }
          if (issue.reason === 'INVALID_FORMAT') {
            if (!issue.rawValue || issue.rawValue.trim().length === 0) {
              return `• Search keyword cannot be empty.`;
            }
            return `• Search keyword "${issue.rawValue}" is invalid or exceeds the maximum length of 100 characters.`;
          }
          if (issue.reason === 'UNRESOLVED') {
            return `• Search verification paused at the safe scan limit. Retry the same search to continue from the cached position, or narrow it with account, category, or date filters.`;
          }
          return `• Search query "${issue.rawValue}" could not be processed.`;
        }
        return `• ${issue.message}`;
      });
      return [
        '⚠️ *Transaction History Filter Not Found:*',
        ...issueLines,
        '',
        '💡 _Tip: Check your filter spelling, or type *history* without filters to view all transactions._',
      ].join('\n');
    },
    outOfBounds(totalCount: number): string {
      return `This page exceeds available transactions (Total: ${totalCount} transactions).`;
    },
    navigationHint(
      nextPage: number,
      options?: { limit?: number; sort?: TransactionSortOrder; filterTokens?: string[] }
    ): string {
      const commandParts = ['history'];
      if (options?.filterTokens && options.filterTokens.length > 0) {
        commandParts.push(...options.filterTokens);
      }
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
    typeExpense: 'Expense',
    typeIncome: 'Income',
    searchBadge(keyword: string): string {
      return `Search: "${keyword}"`;
    },
    convertToBadge(currencyCode: string): string {
      return `Converted: ${currencyCode.toUpperCase()}`;
    },
  },

  emailPending: {
    formatConfirmationPrompt: formatPendingConfirmationPromptEn,
    formatNotification(params: PendingEmailNotificationParams): string {
      const isTransfer = params.typeLabel.includes('Transfer');
      const icon = params.sourceIcon || '📩';
      const headline = isTransfer ? '🔄 *New Transfer*' : `${icon} *New Payment*`;

      if (isTransfer) {
        const route = params.destinationAccountNameHint
          ? `${params.accountNameHint || 'Account'} ➔ ${params.destinationAccountNameHint}`
          : (params.accountNameHint || 'Account');
        return [
          headline,
          '',
          `🔁 ${params.formattedAmount}`,
          `💳 ${route}`,
          `⏰ ${params.formattedTime}`,
          '',
          formatPendingConfirmationPromptEn({
            ticketId: params.ticketId,
            totalPendingCount: params.totalPendingCount,
          }),
        ].join('\n');
      }

      const merchant = params.counterParty || params.bankDisplayName;
      const category = params.matchedCategoryName || 'General';
      const lines = [
        headline,
        '',
        `${params.formattedAmount} • ${params.accountNameHint || 'Account'}`,
      ];

      if (merchant) {
        lines.push(`🏪 ${merchant}`);
      }

      lines.push(`🏷️ ${category} • ${params.formattedTime}`);

      if (params.note && params.note !== merchant) {
        lines.push(`📝 ${params.note}`);
      }
      if (params.isBankSyncedAccount) {
        lines.push('💡 _This account is linked to Wallet bank sync._');
      }

      lines.push('');
      lines.push(
        formatPendingConfirmationPromptEn({
          ticketId: params.ticketId,
          totalPendingCount: params.totalPendingCount,
        })
      );

      return lines.join('\n');
    },
  },

  status: {
    header: '📋 *Transaction Status*',
    emptyAttention: 'There are no transactions requiring attention at this time.',
    needsCheckHeader(count: number): string {
      return `⚠️ *${count} transaction(s) need check:*`;
    },
    waitingConfirmationHeader(count: number): string {
      return `⏳ *${count} transaction(s) waiting for confirmation:*`;
    },
    waitingAccountHeader(count: number): string {
      return `⏳ *${count} transaction(s) waiting for account selection:*`;
    },
    waitingCategoryHeader(count: number): string {
      return `🏷️ *${count} transaction(s) waiting for category selection:*`;
    },
    noOtherTransactionsWaiting: 'No other transactions waiting for confirmation.',
  },

  uncertain: {
    title: '⚠️ *Cannot confirm whether transaction was recorded*',
    riskWarning: 'Do not retry this transaction yet to avoid duplicate records. This transaction will not be retried automatically.',
    actionPromptSingle: 'Check Wallet, then reply:\n• *Already exists*\n• *Not there*',
    actionPromptMultiple(tickets: number[]): string {
      const commandLines = tickets.map(
        ticketId => `• *Already exists #${ticketId}* or *Not there #${ticketId}*`
      );
      return `Check Wallet, then reply:\n${commandLines.join('\n')}`;
    },
  },

  reconciliation: {
    recordedWithTicket(ticketId: number): string {
      return `✅ Transaction #${ticketId} is confirmed as already recorded in Wallet.\nNo retry will be sent.`;
    },
    recordedSingle: '✅ The transaction is confirmed as already recorded in Wallet.\nNo retry will be sent.',
    absentWithTicket(ticketId: number): string {
      return `⚠️ Transaction #${ticketId} is not recorded in Wallet.\nThe item is moved back to waiting for confirmation.\nReply *Yes #${ticketId}* to retry recording, or *Cancel #${ticketId}* to cancel.`;
    },
    absentSingle: '⚠️ The transaction is not recorded in Wallet.\nThe item is moved back to waiting for confirmation.\nReply *Yes* to retry recording, or *Cancel* to cancel.',
    notFoundWithTicket(ticketId: number): string {
      return `⚠️ Transaction #${ticketId} was not found or has already been resolved.`;
    },
    notFoundNone: 'There are no transactions requiring verification at this time.',
    ambiguous(ticketIds: number[]): string {
      const ticketList = ticketIds.map(ticketId => `#${ticketId}`).join(', ');
      return `⚠️ Multiple transactions require checking (${ticketList}). Reply with the ticket number, e.g. *Already exists #${ticketIds[0]}* or *Not there #${ticketIds[0]}*.`;
    },
  },

  confirmation: {
    singleSuccess(params: PendingConfirmationSuccessParams): string {
      if (params.isTransfer) {
        const route = params.destinationAccountNameHint
          ? `${params.accountNameHint || 'Account'} ➔ ${params.destinationAccountNameHint}`
          : (params.accountNameHint || 'Account');
        return [
          `✅ *Transfer successfully recorded!*`,
          '',
          `🔁 ${params.formattedAmount}`,
          `💳 ${route}`,
          `⏰ ${params.formattedTime}`,
        ].join('\n');
      }

      const labelLine = params.labels && params.labels.length > 0
        ? `\n🔖 ${params.labels.map(label => `#${label}`).join(' ')}`
        : '';

      const title = params.merchantOrNote || 'Transaction';
      return [
        `✅ *${title}* successfully recorded!`,
        '',
        `${params.icon || '💸'} ${params.formattedAmount}  •  ${params.accountNameHint || 'Account'}`,
        `🏷️ ${params.matchedCategoryName || 'General'}  •  ${params.formattedTime}${labelLine}`,
      ].join('\n');
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

    itemProcessing(ticketId: number): string {
      return `⏳ *Transaction #${ticketId} is currently being processed...*\nPlease wait a moment while it is being recorded to Wallet.`;
    },

    itemAlreadyResolved(ticketId: number): string {
      return `ℹ️ *Transaction #${ticketId} was already successfully recorded.*`;
    },

    itemNotFound(ticketId?: number): string {
      return ticketId
        ? `ℹ️ *Ticket #${ticketId} not found or already completed.*`
        : 'ℹ️ *No pending transactions waiting for confirmation.*';
    },

    noPendingItems: 'ℹ️ *No pending transactions waiting for confirmation.*',

    itemProcessingCannotCancel(ticketId: number): string {
      return `⏳ *Transaction #${ticketId} is currently being processed and cannot be cancelled.*`;
    },

    cancellationNotFound(ticketId?: number): string {
      return ticketId
        ? `ℹ️ *Ticket #${ticketId} not found or already cancelled.*`
        : 'ℹ️ *No pending transactions waiting for confirmation.*';
    },
  },

  help: {
    welcomeGuidance: [
      'Type your expense directly, for example:',
      '"Lunch 30k Cash" or "Gas 50k Gopay"',
      '',
      'Or send a receipt photo — recorded instantly.',
    ].join('\n'),
  },

  telegramMenu: {
    buttonBalance: '\u{1F4B0} Check Balance',
    buttonBudget: '\u{1F4CA} Check Budget',
    buttonHistory: '\u{1F4DC} History',
    buttonGuide: '\u{2753} Guide',

    commandBalanceDescription: 'Check all account balances',
    commandBudgetDescription: 'Check budget limits and remaining balance',
    commandHistoryDescription: 'Check recent transaction history',
    commandSummaryDescription: 'Check this month expense summary',
    commandMenuDescription: 'Open main menu and guide',
    commandSettingsDescription: 'Open bot settings menu',
    commandRescanDescription: 'Rescan and reconcile inbound emails & notifications (e.g. /rescan 60)',

    topicRecord: '\u{1F4DD} Record Transaction',
    topicTransfer: '\u{1F504} Transfer Funds',
    topicEditDelete: '\u{270F}\u{FE0F} Edit & Delete',
    topicReceipt: '\u{1F4F8} Receipt Photo',
    topicSummaryFilter: '\u{1F50D} Summary & Filter',
    topicFastCommands: '\u{26A1} Quick Commands',
    buttonBack: '\u{1F519} Back to Guide Menu',

    guideHomeTitle: '<b>\u{1F4D6} Wallet Bot User Guide</b>',
    guideHomeSubtitle: 'Select a topic below to explore format examples and usage instructions:',
    guideRecordContent: [
      '<b>\u{1F4DD} Record Expenses &amp; Income</b>',
      '',
      'Type amount, note, and account using natural everyday language.',
      '',
      '<b>Examples:</b>',
      '\u{2022} <i>Lunch 35k BCA</i>',
      '\u{2022} <i>Gas 50k Cash</i>',
      '\u{2022} <i>Monthly salary 10M to Mandiri</i>',
      '\u{2022} <i>Sold used item 150000 Gopay</i>',
      '',
      '\u{1F4A1} <i>Tip: The bot automatically recognizes amount abbreviations (k, m) and matches categories intelligently.</i>',
    ].join('\n'),
    guideTransferContent: [
      '<b>\u{1F504} Record Inter-Account Transfers</b>',
      '',
      'Move funds between banks or wallets without affecting your total net worth.',
      '',
      '<b>Examples:</b>',
      '\u{2022} <i>Transfer 500k from BCA to Mandiri</i>',
      '\u{2022} <i>Topup Gopay 100k using BCA</i>',
      '\u{2022} <i>Transfer 200k BCA to Shopeepay</i>',
      '\u{2022} <i>ATM withdrawal 300k Mandiri to Cash</i>',
    ].join('\n'),
    guideEditDeleteContent: [
      '<b>\u{270F}\u{FE0F} Edit &amp; Delete Transactions (Via Reply)</b>',
      '',
      'Mistyped an amount or category? Simply <b>swipe / reply</b> to the confirmation receipt message from the bot!',
      '',
      '<b>1. How to Edit a Transaction:</b>',
      'Reply to the bot receipt with:',
      '\u{2022} <code>a: 35k</code> (change amount)',
      '\u{2022} <code>c: Food</code> (change category)',
      '\u{2022} <code>rek: BCA</code> (change account)',
      '\u{2022} <code>n: Treat friend t: #coffee</code> (add note &amp; tag)',
      '\u{2022} <code>a: 45k c: Leisure rek: BCA</code> (modify multiple at once)',
      '',
      '<b>2. How to Delete / Cancel:</b>',
      '\u{2022} Reply to the bot receipt and type <code>delete</code> or <code>cancel</code>.',
      '  The bot will immediately delete the transaction from Wallet.',
    ].join('\n'),
    guideReceiptContent: [
      '<b>\u{1F4F8} Send Receipt Photo (Vision)</b>',
      '',
      'Do not feel like typing? Just snap a photo of your receipt and send it here!',
      '',
      '<b>How it works:</b>',
      '1. Take a photo of your receipt (grocery, fuel, restaurant, etc.).',
      '2. Send the photo to this chat (you can add account caption, e.g. <i>using BCA</i>).',
      '3. AI Vision will read the total amount, merchant name, and record it automatically.',
    ].join('\n'),
    guideSummaryFilterContent: [
      '<b>\u{1F50D} Summary &amp; History Queries</b>',
      '',
      'Fast direct queries without AI token usage:',
      '',
      '<b>Example Commands:</b>',
      '\u{2022} <i>Summary this month</i>',
      '\u{2022} <i>Last week expenses</i>',
      '\u{2022} <i>10 recent transactions</i>',
      '\u{2022} <i>BCA history</i>',
      '\u{2022} <i>Check pending queue</i>',
    ].join('\n'),
    guideFastCommandsContent: [
      '<b>\u{26A1} Quick Commands</b>',
      '',
      'Bottom keyboard buttons are always ready to use:',
      '\u{2022} <b>Check Balance</b> \u{2014} Net worth &amp; account breakdown',
      '\u{2022} <b>Check Budget</b> \u{2014} Active budget limits and progress',
      '\u{2022} <b>History</b> \u{2014} 5 most recent transactions',
      '\u{2022} <b>Guide</b> \u{2014} Show this user guide',
    ].join('\n'),
  },

  telegramSettings: {
    title: '<b>⚙️ Bot Settings</b>',
    subtitle: 'Active runtime configuration and bot operational preferences:',
    activeSummaryHeader: '📊 <b>Active Runtime Configuration:</b>',
    savedAlert: '✅ Settings updated successfully!',
    resetAlert: '🔄 Settings reset to system defaults!',
    unauthorizedAlert: '⛔ Access denied. Only the bot owner can modify settings.',

    buttonCategoryMode: '🏷 Category Mode',
    buttonAiModel: '🤖 AI Model & Provider',
    buttonLanguage: '🌐 Response Language',
    buttonCurrency: '💱 Currency',
    buttonAdvanced: '🛠 Advanced Settings',
    buttonBackToMain: '🔙 Back to Settings Menu',
    buttonBackToAdvanced: '🔙 Back to Advanced',
    buttonClose: '✖️ Close Menu',

    categoryTitle: '<b>🏷 Category Resolution Mode</b>',
    categoryInfo: 'Function: Determines whether bot asks for clarification on ambiguous categories or chooses automatically.',
    categoryOptionAsk: 'Ask when ambiguous (ask)',
    categoryOptionAuto: 'Automatic best-match (auto)',

    aiModelTitle: '<b>🤖 AI Model & Provider</b>',
    aiModelInfo: 'Function: Selects the primary LLM model for extracting transactions, receipts, and classifications.',
    aiModelOptionFlashLite: 'Gemini 3.5 Flash Lite (Fast & Efficient)',
    aiModelOptionFlash: 'Gemini 3.8 Flash (High Accuracy)',
    aiModelOptionFallbackChain: 'Fallback Chain (3.6-flash, 3.8-flash)',

    languageTitle: '<b>🌐 Response Language</b>',
    languageInfo: 'Function: Configures the language for bot replies, reports, and transaction confirmations.',
    languageOptionId: '🇮🇩 Bahasa Indonesia (id)',
    languageOptionEn: '🇬🇧 English (en)',

    currencyTitle: '<b>💱 Default Currency</b>',
    currencyInfo: 'Function: Defines the base currency when amounts are recorded without currency symbols.',

    advancedTitle: '<b>🛠 Advanced Settings</b>',
    advancedInfo: 'Function: Configures performance, message queuing, log retention, and system sync.',
    advancedButtonTimezone: '🌍 Timezone',
    advancedButtonAiTimeout: '⏱ AI Request Timeout',
    advancedButtonEmailLookback: '📬 Email Lookback',
    advancedButtonQueueInterval: '⏳ Queue Throttle Interval',
    advancedButtonLogRetention: '🗄 Log Retention',
    advancedButtonReset: '🔄 Reset to Defaults',

    timezoneTitle: '<b>🌍 Operational Timezone</b>',
    timezoneInfo: 'Function: Sets the operational timezone for transaction timestamping.',

    aiTimeoutTitle: '<b>⏱ AI Request Timeout</b>',
    aiTimeoutInfo: 'Function: Maximum duration to await AI responses before switching to fallback models.',

    emailLookbackTitle: '<b>📬 Email Sync Lookback</b>',
    emailLookbackInfo: 'Function: Lookback window for fetching inbound transaction emails from IMAP.',

    queueIntervalTitle: '<b>⏳ Message Queue Throttle</b>',
    queueIntervalInfo: 'Function: Throttling interval for outgoing messages to prevent API rate limiting.',

    logRetentionTitle: '<b>🗄 Log File Retention</b>',
    logRetentionInfo: 'Function: Retention period for application log files before automatic cleanup.',

    resetConfirmTitle: '<b>🔄 Reset Settings to Defaults</b>',
    resetConfirmInfo: 'Function: Reverts all runtime configurations back to system initial settings (.env / defaults).',
    resetConfirmPrompt: '⚠️ <b>Confirm Reset:</b>\nAre you sure you want to delete runtime settings and restore initial values (.env)?',
    resetConfirmButton: '✅ Yes, Reset Now',
    resetCancelButton: '❌ Cancel',

    autoRecordEnrichedToggleLabel: (enabled: boolean) => `⚡ Auto-Record Enriched: ${enabled ? 'ACTIVE [ON]' : 'DISABLED [OFF]'}`,
    debugToggleLabel: (enabled: boolean) => `🐞 Debug Logging: ${enabled ? 'ACTIVE [ON]' : 'DISABLED [OFF]'}`,
    debugTitle: '<b>🐞 Debug Payload Logging</b>',
    debugInfo: 'Function: Enables verbose payload logging to daily log files for troubleshooting.',
    debugOptionOn: 'Active (ON)',
    debugOptionOff: 'Disabled (OFF)',
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
    receiptExtractionFailed(timestampString: string): string {
      return [
        '⚠️ Could not clearly read the receipt image.',
        'Please make sure the photo is well-lit and legible, or resend with a caption like: _"Lunch 35k using Gopay"_',
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
    mediaTooLarge(maxMegabytes: number): string {
      return `⚠️ Photo size exceeds the maximum limit (${maxMegabytes} MB). Please send a smaller photo!`;
    },
    mediaDownloadFailed(channelDisplayName: string): string {
      return `⚠️ Failed to download receipt photo from ${channelDisplayName}. Please try sending it again!`;
    },
    recordEditAccountNotFound(accountHint: string): string {
      return `⚠️ Account "${accountHint}" not found.`;
    },
    recordEditAccountAmbiguous(accountHint: string, candidates: string[]): string {
      return `⚠️ Account "${accountHint}" is ambiguous: matches ${candidates.join(', ')}.`;
    },
    recordEditSourceBankSynced(accountName: string): string {
      return `⚠️ Transactions in bank-synced accounts (${accountName}) cannot be moved to another account.`;
    },
    recordEditTargetBankSynced(accountName: string): string {
      return `⚠️ Cannot move transactions to a bank-synced account (${accountName}).`;
    },
    recordEditCurrencyMismatch(
      sourceAccount: string,
      sourceCurrency: string,
      targetAccount: string,
      targetCurrency: string
    ): string {
      return `⚠️ Cannot move transaction: Currency of ${sourceAccount} (${sourceCurrency}) does not match ${targetAccount} (${targetCurrency}). BudgetBakers only permits moving records between accounts with identical currencies.`;
    },
    recordEditZeroAmount: '⚠️ Transaction amount cannot be 0.',
    recordEditCategoryNotFound(categoryHint: string): string {
      return `⚠️ Category "${categoryHint}" not found or cannot be assigned.`;
    },
    recordEditCategoryAutoNotFound(hint?: string): string {
      return hint && hint.trim().length > 0
        ? `⚠️ Could not automatically infer category for "${hint}".`
        : '⚠️ Could not automatically infer category for this transaction.';
    },
    recordEditNotFound: '⚠️ Transaction not found or the replied message has expired.',
    recordEditFailed(reason: string): string {
      return `❌ Failed to update transaction: ${reason}`;
    },
  },
};
