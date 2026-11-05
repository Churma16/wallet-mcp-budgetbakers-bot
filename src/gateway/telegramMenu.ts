import { InlineKeyboard, Keyboard } from 'grammy';
import { getDictionary, SupportedLanguage } from '../i18n/index.js';

/**
 * Standard Telegram bot command specifications registered via bot.api.setMyCommands.
 */
export function getTelegramBotCommands(languageCode?: SupportedLanguage): Array<{ command: string; description: string }> {
  const dictionary = getDictionary(languageCode).telegramMenu;
  return [
    { command: 'saldo', description: dictionary.commandBalanceDescription },
    { command: 'budget', description: dictionary.commandBudgetDescription },
    { command: 'riwayat', description: dictionary.commandHistoryDescription },
    { command: 'rekap', description: dictionary.commandSummaryDescription },
    { command: 'menu', description: dictionary.commandMenuDescription },
    { command: 'settings', description: dictionary.commandSettingsDescription },
    { command: 'rescan', description: dictionary.commandRescanDescription },
  ];
}

/**
 * Creates the persistent 4-button main menu reply keyboard for Telegram.
 */
export function createTelegramMainReplyKeyboard(languageCode?: SupportedLanguage): Keyboard {
  const dictionary = getDictionary(languageCode).telegramMenu;
  return new Keyboard()
    .text(dictionary.buttonBalance)
    .text(dictionary.buttonBudget)
    .row()
    .text(dictionary.buttonHistory)
    .text(dictionary.buttonGuide)
    .resized()
    .persistent();
}

/**
 * Creates the 6-topic interactive guide inline keyboard.
 */
export function createTelegramGuideInlineKeyboard(languageCode?: SupportedLanguage): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramMenu;
  return new InlineKeyboard()
    .text(dictionary.topicRecord, 'guide:record')
    .text(dictionary.topicTransfer, 'guide:transfer')
    .row()
    .text(dictionary.topicEditDelete, 'guide:edit_delete')
    .text(dictionary.topicReceipt, 'guide:receipt')
    .row()
    .text(dictionary.topicSummaryFilter, 'guide:summary_filter')
    .text(dictionary.topicFastCommands, 'guide:fast_commands');
}

/**
 * Creates the back button inline keyboard for returning to the guide home overview.
 */
export function createTelegramBackButtonInlineKeyboard(languageCode?: SupportedLanguage): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramMenu;
  return new InlineKeyboard().text(dictionary.buttonBack, 'guide:home');
}

export interface TelegramGuideTopicContent {
  readonly text: string;
  readonly replyMarkup: InlineKeyboard;
}

/**
 * Resolves the structured HTML guide content and corresponding inline keyboard
 * for a specific interactive guide topic.
 */
export function getTelegramGuideTopicContent(
  topic: string,
  languageCode?: SupportedLanguage
): TelegramGuideTopicContent | null {
  const normalizedTopic = topic.trim().toLowerCase();
  const dictionary = getDictionary(languageCode).telegramMenu;

  switch (normalizedTopic) {
    case 'home':
    case 'overview': {
      const text = [dictionary.guideHomeTitle, '', dictionary.guideHomeSubtitle].join('\n');
      return {
        text,
        replyMarkup: createTelegramGuideInlineKeyboard(languageCode),
      };
    }

    case 'record':
      return {
        text: dictionary.guideRecordContent,
        replyMarkup: createTelegramBackButtonInlineKeyboard(languageCode),
      };

    case 'transfer':
      return {
        text: dictionary.guideTransferContent,
        replyMarkup: createTelegramBackButtonInlineKeyboard(languageCode),
      };

    case 'edit_delete':
      return {
        text: dictionary.guideEditDeleteContent,
        replyMarkup: createTelegramBackButtonInlineKeyboard(languageCode),
      };

    case 'receipt':
      return {
        text: dictionary.guideReceiptContent,
        replyMarkup: createTelegramBackButtonInlineKeyboard(languageCode),
      };

    case 'summary_filter':
      return {
        text: dictionary.guideSummaryFilterContent,
        replyMarkup: createTelegramBackButtonInlineKeyboard(languageCode),
      };

    case 'fast_commands':
      return {
        text: dictionary.guideFastCommandsContent,
        replyMarkup: createTelegramBackButtonInlineKeyboard(languageCode),
      };

    default:
      return null;
  }
}
