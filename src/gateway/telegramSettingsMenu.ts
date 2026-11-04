import { InlineKeyboard } from 'grammy';
import { getDictionary, SupportedLanguage } from '../i18n/index.js';
import {
  REVERSE_TIMEZONE_ALIAS_MAP,
  RuntimeSettings,
  RuntimeSettingsManager,
} from '../config/runtimeSettingsManager.js';

export type TelegramSettingsMenuPage =
  | 'home'
  | 'category'
  | 'ai_model'
  | 'language'
  | 'currency'
  | 'advanced'
  | 'timezone'
  | 'ai_timeout'
  | 'email_lookback'
  | 'queue_interval'
  | 'log_retention'
  | 'reset_confirm';

export interface TelegramSettingsMenuContent {
  readonly text: string;
  readonly replyMarkup: InlineKeyboard;
}

export function createSettingsMainInlineKeyboard(
  settings: RuntimeSettings,
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;

  return new InlineKeyboard()
    .text(dictionary.buttonCategoryMode, 'settings:page:category')
    .text(dictionary.buttonAiModel, 'settings:page:ai_model')
    .row()
    .text(dictionary.buttonLanguage, 'settings:page:language')
    .text(dictionary.buttonCurrency, 'settings:page:currency')
    .row()
    .text(dictionary.buttonAdvanced, 'settings:page:advanced')
    .row()
    .text(dictionary.debugToggleLabel(settings.debugLoggingEnabled), 'settings:toggle:debug')
    .row()
    .text(dictionary.buttonClose, 'settings:action:close');
}

export function createCategoryInlineKeyboard(
  activeMode: 'ask' | 'auto',
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;

  return new InlineKeyboard()
    .text(
      `${activeMode === 'ask' ? '✅ ' : ''}${dictionary.categoryOptionAsk}`,
      'settings:set:category:ask'
    )
    .row()
    .text(
      `${activeMode === 'auto' ? '✅ ' : ''}${dictionary.categoryOptionAuto}`,
      'settings:set:category:auto'
    )
    .row()
    .text(dictionary.buttonBackToMain, 'settings:home');
}

export function createAiModelInlineKeyboard(
  settings: RuntimeSettings,
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;
  const isFlashLite = settings.aiModel === 'gemini-3.5-flash-lite';
  const isFlash = settings.aiModel === 'gemini-3.8-flash';
  const hasFallbackChain =
    Array.isArray(settings.aiFallbackModels) && settings.aiFallbackModels.length > 0;

  return new InlineKeyboard()
    .text(
      `${isFlashLite ? '✅ ' : ''}${dictionary.aiModelOptionFlashLite}`,
      'settings:set:ai_model:gemini-3.5-flash-lite'
    )
    .row()
    .text(
      `${isFlash ? '✅ ' : ''}${dictionary.aiModelOptionFlash}`,
      'settings:set:ai_model:gemini-3.8-flash'
    )
    .row()
    .text(
      `${hasFallbackChain ? '✅ ' : ''}${dictionary.aiModelOptionFallbackChain}`,
      'settings:toggle:ai_fallback'
    )
    .row()
    .text(dictionary.buttonBackToMain, 'settings:home');
}

export function createLanguageInlineKeyboard(
  activeLang: 'id' | 'en',
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;

  return new InlineKeyboard()
    .text(
      `${activeLang === 'id' ? '✅ ' : ''}${dictionary.languageOptionId}`,
      'settings:set:language:id'
    )
    .row()
    .text(
      `${activeLang === 'en' ? '✅ ' : ''}${dictionary.languageOptionEn}`,
      'settings:set:language:en'
    )
    .row()
    .text(dictionary.buttonBackToMain, 'settings:home');
}

export function createCurrencyInlineKeyboard(
  activeCurrency: string,
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;
  const normalized = (activeCurrency || '').toUpperCase();

  return new InlineKeyboard()
    .text(`${normalized === 'IDR' ? '✅ ' : ''}IDR`, 'settings:set:currency:IDR')
    .text(`${normalized === 'USD' ? '✅ ' : ''}USD`, 'settings:set:currency:USD')
    .row()
    .text(`${normalized === 'SGD' ? '✅ ' : ''}SGD`, 'settings:set:currency:SGD')
    .text(`${normalized === 'EUR' ? '✅ ' : ''}EUR`, 'settings:set:currency:EUR')
    .row()
    .text(dictionary.buttonBackToMain, 'settings:home');
}

export function createAdvancedInlineKeyboard(
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;

  return new InlineKeyboard()
    .text(dictionary.advancedButtonTimezone, 'settings:page:timezone')
    .text(dictionary.advancedButtonAiTimeout, 'settings:page:ai_timeout')
    .row()
    .text(dictionary.advancedButtonEmailLookback, 'settings:page:email_lookback')
    .text(dictionary.advancedButtonQueueInterval, 'settings:page:queue_interval')
    .row()
    .text(dictionary.advancedButtonLogRetention, 'settings:page:log_retention')
    .row()
    .text(dictionary.advancedButtonReset, 'settings:page:reset_confirm')
    .row()
    .text(dictionary.buttonBackToMain, 'settings:home');
}

export function createTimezoneInlineKeyboard(
  activeTimezone: string,
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;
  const alias = REVERSE_TIMEZONE_ALIAS_MAP[activeTimezone] || activeTimezone;

  return new InlineKeyboard()
    .text(
      `${alias === 'WIB' ? '✅ ' : ''}WIB (Asia/Jakarta, UTC+7)`,
      'settings:set:timezone:WIB'
    )
    .row()
    .text(
      `${alias === 'WITA' ? '✅ ' : ''}WITA (Asia/Makassar, UTC+8)`,
      'settings:set:timezone:WITA'
    )
    .row()
    .text(
      `${alias === 'WIT' ? '✅ ' : ''}WIT (Asia/Jayapura, UTC+9)`,
      'settings:set:timezone:WIT'
    )
    .row()
    .text(
      `${alias === 'UTC' ? '✅ ' : ''}UTC (UTC+0)`,
      'settings:set:timezone:UTC'
    )
    .row()
    .text(dictionary.buttonBackToAdvanced, 'settings:page:advanced');
}

export function createAiTimeoutInlineKeyboard(
  activeSeconds: number,
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;

  return new InlineKeyboard()
    .text(`${activeSeconds === 15 ? '✅ ' : ''}15s`, 'settings:set:ai_timeout:15')
    .text(`${activeSeconds === 20 ? '✅ ' : ''}20s`, 'settings:set:ai_timeout:20')
    .row()
    .text(`${activeSeconds === 30 ? '✅ ' : ''}30s`, 'settings:set:ai_timeout:30')
    .text(`${activeSeconds === 45 ? '✅ ' : ''}45s`, 'settings:set:ai_timeout:45')
    .row()
    .text(dictionary.buttonBackToAdvanced, 'settings:page:advanced');
}

export function createEmailLookbackInlineKeyboard(
  activeMinutes: number,
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;

  return new InlineKeyboard()
    .text(`${activeMinutes === 5 ? '✅ ' : ''}5m`, 'settings:set:email_lookback:5')
    .text(`${activeMinutes === 10 ? '✅ ' : ''}10m`, 'settings:set:email_lookback:10')
    .row()
    .text(`${activeMinutes === 15 ? '✅ ' : ''}15m`, 'settings:set:email_lookback:15')
    .text(`${activeMinutes === 30 ? '✅ ' : ''}30m`, 'settings:set:email_lookback:30')
    .row()
    .text(dictionary.buttonBackToAdvanced, 'settings:page:advanced');
}

export function createQueueIntervalInlineKeyboard(
  activeIntervalMs: number,
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;

  return new InlineKeyboard()
    .text(`${activeIntervalMs === 500 ? '✅ ' : ''}500ms`, 'settings:set:queue_interval:500')
    .text(`${activeIntervalMs === 1000 ? '✅ ' : ''}1000ms`, 'settings:set:queue_interval:1000')
    .row()
    .text(`${activeIntervalMs === 2000 ? '✅ ' : ''}2000ms`, 'settings:set:queue_interval:2000')
    .text(`${activeIntervalMs === 3000 ? '✅ ' : ''}3000ms`, 'settings:set:queue_interval:3000')
    .row()
    .text(dictionary.buttonBackToAdvanced, 'settings:page:advanced');
}

export function createLogRetentionInlineKeyboard(
  activeDays: number,
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;

  return new InlineKeyboard()
    .text(`${activeDays === 3 ? '✅ ' : ''}3d`, 'settings:set:log_retention:3')
    .text(`${activeDays === 7 ? '✅ ' : ''}7d`, 'settings:set:log_retention:7')
    .row()
    .text(`${activeDays === 14 ? '✅ ' : ''}14d`, 'settings:set:log_retention:14')
    .text(`${activeDays === 30 ? '✅ ' : ''}30d`, 'settings:set:log_retention:30')
    .row()
    .text(dictionary.buttonBackToAdvanced, 'settings:page:advanced');
}

export function createResetConfirmInlineKeyboard(
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;

  return new InlineKeyboard()
    .text(dictionary.resetConfirmButton, 'settings:action:reset')
    .row()
    .text(dictionary.resetCancelButton, 'settings:page:advanced');
}

/**
 * Resolves the complete rendered HTML text and 2-level inline keyboard navigation
 * for the interactive Telegram settings menu.
 */
export function getTelegramSettingsMenuContent(
  page: TelegramSettingsMenuPage = 'home',
  languageCode?: SupportedLanguage,
  settingsManager?: RuntimeSettingsManager
): TelegramSettingsMenuContent {
  const manager = settingsManager || RuntimeSettingsManager.getInstance();
  const settings = manager.getSettings();
  const dictionary = getDictionary(languageCode).telegramSettings;

  switch (page) {
    case 'home': {
      const timezoneAlias = REVERSE_TIMEZONE_ALIAS_MAP[settings.appTimezone] || settings.appTimezone;
      const text = [
        dictionary.title,
        dictionary.subtitle,
        '',
        dictionary.activeSummaryHeader,
        `• <b>Mode Kategori:</b> <code>${settings.categoryResolutionMode}</code>`,
        `• <b>Model AI:</b> <code>${settings.aiModel}</code>`,
        `• <b>Fallback AI:</b> <code>${settings.aiFallbackModels.join(', ') || 'none'}</code>`,
        `• <b>Bahasa Respon:</b> <code>${settings.appLanguage === 'id' ? 'Indonesia (id)' : 'English (en)'}</code>`,
        `• <b>Mata Uang Default:</b> <code>${settings.defaultCurrency}</code>`,
        `• <b>Zona Waktu:</b> <code>${settings.appTimezone} (${timezoneAlias})</code>`,
        `• <b>AI Timeout:</b> <code>${settings.aiRequestTimeoutSeconds}s</code>`,
        `• <b>Email Lookback:</b> <code>${settings.emailLookbackMinutes}m</code>`,
        `• <b>Antrean Pesan:</b> <code>${settings.whatsappMessageQueueIntervalMs}ms</code>`,
        `• <b>Retensi Log:</b> <code>${settings.logRetentionDays} hari</code>`,
        `• <b>Debug Logging:</b> <code>${settings.debugLoggingEnabled ? 'ON' : 'OFF'}</code>`,
      ].join('\n');

      return {
        text,
        replyMarkup: createSettingsMainInlineKeyboard(settings, languageCode),
      };
    }

    case 'category': {
      const text = [
        dictionary.categoryTitle,
        dictionary.categoryInfo,
        '',
        `Status aktif saat ini: <code>${settings.categoryResolutionMode}</code>`,
      ].join('\n');

      return {
        text,
        replyMarkup: createCategoryInlineKeyboard(settings.categoryResolutionMode, languageCode),
      };
    }

    case 'ai_model': {
      const text = [
        dictionary.aiModelTitle,
        dictionary.aiModelInfo,
        '',
        `Model aktif saat ini: <code>${settings.aiModel}</code>`,
        `Rantai cadangan (fallback): <code>${settings.aiFallbackModels.join(', ') || 'nonaktif'}</code>`,
      ].join('\n');

      return {
        text,
        replyMarkup: createAiModelInlineKeyboard(settings, languageCode),
      };
    }

    case 'language': {
      const text = [
        dictionary.languageTitle,
        dictionary.languageInfo,
        '',
        `Bahasa aktif saat ini: <code>${settings.appLanguage === 'id' ? 'Bahasa Indonesia (id)' : 'English (en)'}</code>`,
      ].join('\n');

      return {
        text,
        replyMarkup: createLanguageInlineKeyboard(settings.appLanguage, languageCode),
      };
    }

    case 'currency': {
      const text = [
        dictionary.currencyTitle,
        dictionary.currencyInfo,
        '',
        `Mata uang aktif saat ini: <code>${settings.defaultCurrency}</code>`,
      ].join('\n');

      return {
        text,
        replyMarkup: createCurrencyInlineKeyboard(settings.defaultCurrency, languageCode),
      };
    }

    case 'advanced': {
      const text = [
        dictionary.advancedTitle,
        dictionary.advancedInfo,
        '',
        'Pilih opsi lanjutan di bawah untuk menyesuaikan parameter teknis bot:',
      ].join('\n');

      return {
        text,
        replyMarkup: createAdvancedInlineKeyboard(languageCode),
      };
    }

    case 'timezone': {
      const tzAlias = REVERSE_TIMEZONE_ALIAS_MAP[settings.appTimezone] || settings.appTimezone;
      const text = [
        dictionary.timezoneTitle,
        dictionary.timezoneInfo,
        '',
        `Zona waktu aktif: <code>${settings.appTimezone} (${tzAlias})</code>`,
      ].join('\n');

      return {
        text,
        replyMarkup: createTimezoneInlineKeyboard(settings.appTimezone, languageCode),
      };
    }

    case 'ai_timeout': {
      const text = [
        dictionary.aiTimeoutTitle,
        dictionary.aiTimeoutInfo,
        '',
        `Batas waktu aktif saat ini: <code>${settings.aiRequestTimeoutSeconds}s</code> (${settings.aiRequestTimeoutSeconds * 1000} ms)`,
      ].join('\n');

      return {
        text,
        replyMarkup: createAiTimeoutInlineKeyboard(settings.aiRequestTimeoutSeconds, languageCode),
      };
    }

    case 'email_lookback': {
      const text = [
        dictionary.emailLookbackTitle,
        dictionary.emailLookbackInfo,
        '',
        `Jendela lookback aktif saat ini: <code>${settings.emailLookbackMinutes} menit</code>`,
      ].join('\n');

      return {
        text,
        replyMarkup: createEmailLookbackInlineKeyboard(settings.emailLookbackMinutes, languageCode),
      };
    }

    case 'queue_interval': {
      const text = [
        dictionary.queueIntervalTitle,
        dictionary.queueIntervalInfo,
        '',
        `Interval antrean pesan saat ini: <code>${settings.whatsappMessageQueueIntervalMs} ms</code>`,
      ].join('\n');

      return {
        text,
        replyMarkup: createQueueIntervalInlineKeyboard(settings.whatsappMessageQueueIntervalMs, languageCode),
      };
    }

    case 'log_retention': {
      const text = [
        dictionary.logRetentionTitle,
        dictionary.logRetentionInfo,
        '',
        `Retensi log saat ini: <code>${settings.logRetentionDays} hari</code>`,
      ].join('\n');

      return {
        text,
        replyMarkup: createLogRetentionInlineKeyboard(settings.logRetentionDays, languageCode),
      };
    }

    case 'reset_confirm': {
      const text = [
        dictionary.resetConfirmTitle,
        dictionary.resetConfirmInfo,
        '',
        dictionary.resetConfirmPrompt,
      ].join('\n');

      return {
        text,
        replyMarkup: createResetConfirmInlineKeyboard(languageCode),
      };
    }

    default:
      return getTelegramSettingsMenuContent('home', languageCode, settingsManager);
  }
}
