import type { WalletMcpClientService } from '../../wallet/index.js';
import type { SupportedLanguage } from '../../i18n/index.js';
import {
  createTelegramBudgetInlineKeyboard,
  type BudgetPeriodFilter,
  type BudgetViewMode,
} from '../../gateway/telegramMenu.js';
import { formatBudgetStatusMessage } from '../../wallet/formatters/budgetFormatter.js';

export interface BudgetCallbackResult {
  readonly text: string;
  readonly replyMarkup: ReturnType<typeof createTelegramBudgetInlineKeyboard>;
  readonly mode: BudgetViewMode;
  readonly period: BudgetPeriodFilter;
}

/**
 * Handles interactive inline keyboard callback queries for mobile budget view:
 * Format: `bgt:<modeKey>:<periodKey>`
 * e.g. `bgt:r:all`, `bgt:d:1w`, `bgt:r:1m`
 */
export async function handleBudgetCallback(
  callbackData: string,
  walletMcpClient?: WalletMcpClientService,
  languageCode?: SupportedLanguage,
  referenceDate: Date = new Date()
): Promise<BudgetCallbackResult | null> {
  if (!walletMcpClient || !callbackData.startsWith('bgt:')) {
    return null;
  }

  const parts = callbackData.split(':');
  if (parts.length < 3) {
    return null;
  }

  const modeChar = parts[1];
  const periodKey = parts[2];

  if (modeChar !== 'r' && modeChar !== 'd') {
    return null;
  }

  const validPeriods: BudgetPeriodFilter[] = ['all', '1w', '1m', '6m', '1y'];
  if (!validPeriods.includes(periodKey as BudgetPeriodFilter)) {
    return null;
  }

  const mode: BudgetViewMode = modeChar === 'd' ? 'detail' : 'compact';
  const period = periodKey as BudgetPeriodFilter;

  const budgets = await walletMcpClient.fetchBudgets();
  const text = formatBudgetStatusMessage(budgets, {
    mode,
    period,
    languageCode,
    referenceDate,
  });

  const replyMarkup = createTelegramBudgetInlineKeyboard(mode, period, languageCode);

  return {
    text,
    replyMarkup,
    mode,
    period,
  };
}
