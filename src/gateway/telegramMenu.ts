import { InlineKeyboard, Keyboard } from 'grammy';
import { getDictionary, getActiveLanguage, SupportedLanguage } from '../i18n/index.js';

/**
 * Standard Telegram bot command specifications registered via bot.api.setMyCommands.
 */
export function getTelegramBotCommands(languageCode?: SupportedLanguage): Array<{ command: string; description: string }> {
  const dictionary = getDictionary(languageCode).telegramMenu;
  return [
    { command: 'saldo', description: dictionary.commandBalanceDescription },
    { command: 'rekap', description: dictionary.commandSummaryDescription },
    { command: 'riwayat', description: dictionary.commandHistoryDescription },
    { command: 'budget', description: dictionary.commandBudgetDescription },
    { command: 'antrean', description: dictionary.commandQueueDescription },
    { command: 'rescan', description: dictionary.commandRescanDescription },
    { command: 'reconciliation', description: dictionary.commandReconciliationDescription },
    { command: 'menu', description: dictionary.commandMenuDescription },
    { command: 'settings', description: dictionary.commandSettingsDescription },
  ];
}

/**
 * Creates the persistent 6-button (3x2) main menu reply keyboard for Telegram.
 */
export function createTelegramMainReplyKeyboard(languageCode?: SupportedLanguage): Keyboard {
  const dictionary = getDictionary(languageCode).telegramMenu;
  return new Keyboard()
    .text(dictionary.buttonBalance)
    .text(dictionary.buttonSummary)
    .row()
    .text(dictionary.buttonBudget)
    .text(dictionary.buttonHistory)
    .row()
    .text(dictionary.buttonQueue)
    .text(dictionary.buttonGuide)
    .resized()
    .persistent();
}

/**
 * Creates the 6-topic interactive guide inline keyboard ordered by user workflow.
 */
export function createTelegramGuideInlineKeyboard(languageCode?: SupportedLanguage): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramMenu;
  return new InlineKeyboard()
    .text(dictionary.topicRecord, 'guide:record')
    .text(dictionary.topicReceipt, 'guide:receipt')
    .row()
    .text(dictionary.topicTransfer, 'guide:transfer')
    .text(dictionary.topicEditDelete, 'guide:edit_delete')
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

/**
 * Creates a 2-column inline keyboard offering duration choices for /rescan.
 * Options: 1 Jam (60m) | 3 Jam (180m)
 *          6 Jam (360m) | 12 Jam (720m)
 *          24 Jam (1440m)
 */
export function createTelegramRescanInlineKeyboard(languageCode?: SupportedLanguage): InlineKeyboard {
  const isEnglish = (languageCode || getActiveLanguage()) === 'en';
  const label1h = isEnglish ? '1 Hour' : '1 Jam';
  const label3h = isEnglish ? '3 Hours' : '3 Jam';
  const label6h = isEnglish ? '6 Hours' : '6 Jam';
  const label12h = isEnglish ? '12 Hours' : '12 Jam';
  const label24h = isEnglish ? '24 Hours' : '24 Jam';

  return new InlineKeyboard()
    .text(label1h, 'rescan:60')
    .text(label3h, 'rescan:180')
    .row()
    .text(label6h, 'rescan:360')
    .text(label12h, 'rescan:720')
    .row()
    .text(label24h, 'rescan:1440');
}

/**
 * Creates an inline keyboard with confirmation and cancellation buttons for transaction deletion.
 */
export function createTelegramDeleteConfirmInlineKeyboard(
  targetMessageId: string,
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).records;
  const deleteButtonText = dictionary.deleteConfirmButton || '🗑️ Hapus';
  const cancelButtonText = dictionary.deleteCancelButton || '❌ Batal';

  return new InlineKeyboard()
    .text(deleteButtonText, `delete:confirm:${targetMessageId}`)
    .text(cancelButtonText, `delete:cancel:${targetMessageId}`);
}

/**
 * Creates an inline keyboard with confirmation and cancellation buttons for a pending transaction ticket.
 */
export function createTelegramPendingConfirmInlineKeyboard(
  ticketId: number,
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode);
  return new InlineKeyboard()
    .text(dictionary.status.queueCancelButton, `pending:reject:${ticketId}`)
    .text(dictionary.status.queueConfirmButton, `pending:confirm:${ticketId}`);
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

/**
 * Creates an inline keyboard displaying available accounts for /reconciliation,
 * arranged 2 buttons per row, plus a cancel button at the bottom.
 */
export function createTelegramReconciliationAccountSelectionKeyboard(
  accounts: ReadonlyArray<{ id: string; name: string }>
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let i = 0; i < accounts.length; i += 2) {
    keyboard.text(accounts[i].name, `recon:select_acc:${accounts[i].id}`);
    if (i + 1 < accounts.length) {
      keyboard.text(accounts[i + 1].name, `recon:select_acc:${accounts[i + 1].id}`);
    }
    keyboard.row();
  }
  keyboard.text('❌ Batal', 'recon:cancel_prompt');
  return keyboard;
}

/**
 * Creates an inline keyboard with a cancel button for active reconciliation upload prompt.
 */
export function createTelegramReconciliationCancelInlineKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('❌ Batalkan', 'recon:cancel_prompt');
}

