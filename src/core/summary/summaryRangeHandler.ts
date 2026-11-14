import type { TransactionSummaryService } from '../../wallet/index.js';
import type { SupportedLanguage } from '../../i18n/index.js';
import { formatTransactionSummaryMessage } from '../../wallet/formatters/transactionSummaryFormatter.js';
import {
  createTelegramSummaryRangeKeyboard,
  type SummaryRangeKey,
} from '../../gateway/telegramMenu.js';
import type { RelativeDatePeriod } from '../../wallet/history/queryTypes.js';

export const SUMMARY_RANGE_TO_PERIOD: Record<SummaryRangeKey, RelativeDatePeriod> = {
  '1w': 'this_week',
  '1m': 'this_month',
  '6m': 'last_6_months',
  '1y': 'this_year',
};

export interface SummaryRangeCallbackResult {
  readonly text: string;
  readonly replyMarkup: ReturnType<typeof createTelegramSummaryRangeKeyboard>;
  readonly rangeKey: SummaryRangeKey;
}

export async function handleSummaryRangeCallback(
  callbackData: string,
  summaryService?: TransactionSummaryService,
  languageCode?: SupportedLanguage,
  referenceDate: Date = new Date()
): Promise<SummaryRangeCallbackResult | null> {
  if (!summaryService || !callbackData.startsWith('sum:range:')) {
    return null;
  }

  const rawKey = callbackData.replace('sum:range:', '');
  if (rawKey !== '1w' && rawKey !== '1m' && rawKey !== '6m' && rawKey !== '1y') {
    return null;
  }

  const rangeKey = rawKey as SummaryRangeKey;
  const datePeriod = SUMMARY_RANGE_TO_PERIOD[rangeKey];

  const summaryResult = await summaryService.getTransactionSummary(
    {
      datePeriod,
      groupBy: 'category',
    },
    referenceDate
  );

  const text = formatTransactionSummaryMessage(summaryResult, languageCode);
  const replyMarkup = createTelegramSummaryRangeKeyboard(rangeKey, languageCode);

  return {
    text,
    replyMarkup,
    rangeKey,
  };
}
