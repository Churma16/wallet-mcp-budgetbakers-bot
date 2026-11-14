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
  | 'auto_record'
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

const CURRENCY_PRESETS = ['IDR', 'USD', 'SGD', 'MYR', 'EUR', 'JPY', 'GBP', 'AUD'] as const;

const TIMEZONE_PRESETS: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
  { label: 'WIB (Jakarta, +7)', value: 'WIB' },
  { label: 'WITA (Makassar, +8)', value: 'WITA' },
  { label: 'WIT (Jayapura, +9)', value: 'WIT' },
  { label: 'SGT (Singapore, +8)', value: 'Asia/Singapore' },
  { label: 'JST (Tokyo, +9)', value: 'Asia/Tokyo' },
  { label: 'UTC (+0)', value: 'UTC' },
];

export function createSettingsMainInlineKeyboard(
  _settings: RuntimeSettings,
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;

  return new InlineKeyboard()
    .text(dictionary.buttonCategoryMode, 'settings:page:category')
    .text(dictionary.buttonAutoRecord, 'settings:page:auto_record')
    .row()
    .text(dictionary.buttonLanguage, 'settings:page:language')
    .text(dictionary.buttonCurrency, 'settings:page:currency')
    .row()
    .text(dictionary.buttonAiModel, 'settings:page:ai_model')
    .text(dictionary.buttonAdvanced, 'settings:page:advanced')
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

export function createAutoRecordInlineKeyboard(
  autoRecordEnabled: boolean,
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;

  return new InlineKeyboard()
    .text(
      `${autoRecordEnabled ? '✅ ' : ''}${dictionary.autoRecordOptionOn}`,
      'settings:set:auto_record:on'
    )
    .row()
    .text(
      `${!autoRecordEnabled ? '✅ ' : ''}${dictionary.autoRecordOptionOff}`,
      'settings:set:auto_record:off'
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
    .text(dictionary.aiFallbackToggleLabel(hasFallbackChain), 'settings:toggle:ai_fallback')
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
  const normalized = (activeCurrency || '').trim().toUpperCase();
  const keyboard = new InlineKeyboard();

  CURRENCY_PRESETS.slice(0, 4).forEach(code => {
    keyboard.text(`${normalized === code ? '✅ ' : ''}${code}`, `settings:set:currency:${code}`);
  });
  keyboard.row();

  CURRENCY_PRESETS.slice(4, 8).forEach(code => {
    keyboard.text(`${normalized === code ? '✅ ' : ''}${code}`, `settings:set:currency:${code}`);
  });
  keyboard.row();

  if (normalized && !CURRENCY_PRESETS.includes(normalized as (typeof CURRENCY_PRESETS)[number])) {
    keyboard.text(`✅ ${normalized}`, `settings:set:currency:${normalized}`).row();
  }

  return keyboard.text(dictionary.buttonBackToMain, 'settings:home');
}

export function createAdvancedInlineKeyboard(
  debugLoggingEnabled: boolean = false,
  languageCode?: SupportedLanguage
): InlineKeyboard {
  const dictionary = getDictionary(languageCode).telegramSettings;

  return new InlineKeyboard()
    .text(dictionary.advancedButtonTimezone, 'settings:page:timezone')
    .text(dictionary.advancedButtonEmailLookback, 'settings:page:email_lookback')
    .row()
    .text(dictionary.advancedButtonAiTimeout, 'settings:page:ai_timeout')
    .text(dictionary.advancedButtonQueueInterval, 'settings:page:queue_interval')
    .row()
    .text(dictionary.advancedButtonLogRetention, 'settings:page:log_retention')
    .text(dictionary.debugToggleLabel(debugLoggingEnabled), 'settings:toggle:debug')
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
  const keyboard = new InlineKeyboard();
  let matchedPreset = false;

  for (let i = 0; i < TIMEZONE_PRESETS.length; i += 2) {
    const pair = TIMEZONE_PRESETS.slice(i, i + 2);
    for (const preset of pair) {
      const isActive = alias === preset.value || activeTimezone === preset.value;
      if (isActive) {
        matchedPreset = true;
      }
      keyboard.text(
        `${isActive ? '✅ ' : ''}${preset.label}`,
        `settings:set:timezone:${preset.value}`
      );
    }
    keyboard.row();
  }

  if (activeTimezone && !matchedPreset) {
    keyboard.text(`✅ ${activeTimezone}`, `settings:set:timezone:${activeTimezone}`).row();
  }

  return keyboard.text(dictionary.buttonBackToAdvanced, 'settings:page:advanced');
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
    .text(`${activeMinutes === 15 ? '✅ ' : ''}15m`, 'settings:set:email_lookback:15')
    .row()
    .text(`${activeMinutes === 30 ? '✅ ' : ''}30m`, 'settings:set:email_lookback:30')
    .text(`${activeMinutes === 60 ? '✅ ' : ''}60m`, 'settings:set:email_lookback:60')
    .text(`${activeMinutes === 120 ? '✅ ' : ''}120m`, 'settings:set:email_lookback:120')
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
  const labels = dictionary.summaryLabels;
  const timezoneAlias = REVERSE_TIMEZONE_ALIAS_MAP[settings.appTimezone] || settings.appTimezone;
  const timezoneDisplay =
    timezoneAlias !== settings.appTimezone
      ? `${settings.appTimezone} (${timezoneAlias})`
      : settings.appTimezone;

  switch (page) {
    case 'home': {
      const text = [
        dictionary.title,
        dictionary.subtitle,
        '',
        dictionary.activeSummaryHeader,
        `• <b>${labels.categoryMode}:</b> <code>${settings.categoryResolutionMode}</code>`,
        `• <b>${labels.autoRecord}:</b> <code>${settings.autoRecordEnriched ? 'ON' : 'OFF'}</code>`,
        `• <b>${labels.aiModel}:</b> <code>${settings.aiModel}</code>`,
        `• <b>${labels.aiFallback}:</b> <code>${settings.aiFallbackModels.join(', ') || dictionary.statusFallbackNone}</code>`,
        `• <b>${labels.language}:</b> <code>${settings.appLanguage === 'id' ? 'Indonesia (id)' : 'English (en)'}</code>`,
        `• <b>${labels.currency}:</b> <code>${settings.defaultCurrency}</code>`,
        `• <b>${labels.timezone}:</b> <code>${timezoneDisplay}</code>`,
        `• <b>${labels.aiTimeout}:</b> <code>${settings.aiRequestTimeoutSeconds}s</code>`,
        `• <b>${labels.emailLookback}:</b> <code>${dictionary.unitMinutes(settings.emailLookbackMinutes)}</code>`,
        `• <b>${labels.queueInterval}:</b> <code>${settings.whatsappMessageQueueIntervalMs}ms</code>`,
        `• <b>${labels.logRetention}:</b> <code>${dictionary.unitDays(settings.logRetentionDays)}</code>`,
        `• <b>${labels.debugLogging}:</b> <code>${settings.debugLoggingEnabled ? 'ON' : 'OFF'}</code>`,
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
        dictionary.currentStatusLine(labels.categoryMode, settings.categoryResolutionMode),
      ].join('\n');

      return {
        text,
        replyMarkup: createCategoryInlineKeyboard(settings.categoryResolutionMode, languageCode),
      };
    }

    case 'auto_record': {
      const statusText = settings.autoRecordEnriched
        ? `${dictionary.statusEnabled} (ON)`
        : `${dictionary.statusDisabled} (OFF)`;
      const text = [
        dictionary.autoRecordTitle,
        dictionary.autoRecordInfo,
        '',
        dictionary.currentStatusLine(labels.autoRecord, statusText),
      ].join('\n');

      return {
        text,
        replyMarkup: createAutoRecordInlineKeyboard(settings.autoRecordEnriched, languageCode),
      };
    }

    case 'ai_model': {
      const text = [
        dictionary.aiModelTitle,
        dictionary.aiModelInfo,
        '',
        dictionary.currentStatusLine(labels.aiModel, settings.aiModel),
        dictionary.currentFallbackLine(
          settings.aiFallbackModels.join(', ') || dictionary.statusFallbackNone
        ),
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
        dictionary.currentStatusLine(
          labels.language,
          settings.appLanguage === 'id' ? 'Bahasa Indonesia (id)' : 'English (en)'
        ),
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
        dictionary.currentStatusLine(labels.currency, settings.defaultCurrency),
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
        `• <b>${labels.timezone}:</b> <code>${timezoneDisplay}</code>`,
        `• <b>${labels.emailLookback}:</b> <code>${dictionary.unitMinutes(settings.emailLookbackMinutes)}</code>`,
        `• <b>${labels.aiTimeout}:</b> <code>${settings.aiRequestTimeoutSeconds}s</code>`,
        `• <b>${labels.queueInterval}:</b> <code>${settings.whatsappMessageQueueIntervalMs}ms</code>`,
        `• <b>${labels.logRetention}:</b> <code>${dictionary.unitDays(settings.logRetentionDays)}</code>`,
        `• <b>${labels.debugLogging}:</b> <code>${settings.debugLoggingEnabled ? 'ON' : 'OFF'}</code>`,
        '',
        dictionary.advancedPrompt,
      ].join('\n');

      return {
        text,
        replyMarkup: createAdvancedInlineKeyboard(settings.debugLoggingEnabled, languageCode),
      };
    }

    case 'timezone': {
      const text = [
        dictionary.timezoneTitle,
        dictionary.timezoneInfo,
        '',
        dictionary.currentStatusLine(labels.timezone, timezoneDisplay),
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
        dictionary.currentStatusLine(
          labels.aiTimeout,
          `${settings.aiRequestTimeoutSeconds}s (${settings.aiRequestTimeoutSeconds * 1000} ms)`
        ),
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
        dictionary.currentStatusLine(
          labels.emailLookback,
          dictionary.unitMinutes(settings.emailLookbackMinutes)
        ),
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
        dictionary.currentStatusLine(
          labels.queueInterval,
          `${settings.whatsappMessageQueueIntervalMs} ms`
        ),
      ].join('\n');

      return {
        text,
        replyMarkup: createQueueIntervalInlineKeyboard(
          settings.whatsappMessageQueueIntervalMs,
          languageCode
        ),
      };
    }

    case 'log_retention': {
      const text = [
        dictionary.logRetentionTitle,
        dictionary.logRetentionInfo,
        '',
        dictionary.currentStatusLine(
          labels.logRetention,
          dictionary.unitDays(settings.logRetentionDays)
        ),
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
