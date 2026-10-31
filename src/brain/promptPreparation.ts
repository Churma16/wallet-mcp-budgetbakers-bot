import { WalletAccountItem, WalletCategoryItem } from '../wallet/index.js';
import { GateEvaluationResult } from '../email/index.js';
import { getActiveLanguage } from '../i18n/index.js';
import { getApplicationTimezone } from '../config/applicationConfig.js';
import {
  getCurrentLocalDateString,
  getTimezoneOffsetDetails,
} from './parsers/timeBoundaries.js';
import {
  formatLocalTimeAnchor,
} from './parsers/timeParser.js';
import {
  buildCompactSystemInstruction,
  buildReceiptSystemInstruction,
  buildEmailSystemInstruction,
  buildTextMessagePrompt,
  buildReceiptExtractionPrompt,
  buildEmailEvaluationPrompt,
} from './prompts.js';
import { CategoryContextService } from '../services/categoryContextService.js';
import {
  PreparedTextMessagePrompt,
  PreparedReceiptPrompt,
  PreparedEmailPrompt,
} from './types.js';

/**
 * Reusable system instruction compiler and cache key manager.
 *
 * Core Purpose & Responsibility:
 * Compiles dynamic system instructions for financial AI models and caches the compiled prompt
 * against account, category, timezone, language, and context service fingerprints.
 *
 * Architectural Role:
 * Used internally by FinancialAiProvider implementations (Gemini, OpenAI) to prevent unnecessary
 * string recompilation across repeated incoming messages.
 */
export class SystemInstructionCache {
  private cachedSystemInstruction: string = '';
  private systemInstructionCacheKey: string = '';

  constructor(private readonly categoryContextService?: CategoryContextService) {}

  public getSystemInstruction(
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[],
    referenceDate: Date = new Date()
  ): string {
    const applicationTimezone = getApplicationTimezone();
    const currentDateIso = getCurrentLocalDateString(referenceDate, applicationTimezone);
    const timezoneOffsetDetails = getTimezoneOffsetDetails(applicationTimezone, referenceDate);
    const activeLanguage = getActiveLanguage();
    const contextFingerprint = this.categoryContextService?.getContextFingerprint() || '';
    const accountsFingerprint = availableAccountList
      .map(account => `${account.id}:${account.name}:${account.currency || ''}:${account.bankAccountNumber || ''}`)
      .join(';');
    const categoriesFingerprint = availableCategoryList
      .map(category => `${category.id}:${category.name}`)
      .join(';');
    const cacheKey = `${activeLanguage}|${currentDateIso}|${applicationTimezone}|${timezoneOffsetDetails.formattedOffset}|${accountsFingerprint}|${categoriesFingerprint}|${contextFingerprint}`;

    if (this.systemInstructionCacheKey === cacheKey && this.cachedSystemInstruction) {
      return this.cachedSystemInstruction;
    }

    const formattedCategoryContext = this.categoryContextService?.formatCompactContext(availableCategoryList);

    this.cachedSystemInstruction = buildCompactSystemInstruction(
      availableAccountList,
      availableCategoryList,
      currentDateIso,
      applicationTimezone,
      referenceDate,
      formattedCategoryContext
    );
    this.systemInstructionCacheKey = cacheKey;
    return this.cachedSystemInstruction;
  }

  public getCacheKey(): string {
    return this.systemInstructionCacheKey;
  }
}

/**
 * Prepares the prompt and system instruction for text financial intent extraction.
 */
export function prepareTextMessagePrompt(
  userMessageText: string,
  availableAccountList: WalletAccountItem[],
  availableCategoryList: WalletCategoryItem[],
  referenceInstant: Date,
  systemInstructionCache: SystemInstructionCache
): PreparedTextMessagePrompt {
  const systemInstruction = systemInstructionCache.getSystemInstruction(
    availableAccountList,
    availableCategoryList,
    referenceInstant
  );
  const trimmedUserMessage = userMessageText.trim();
  const currentTransactionTimestampIso = referenceInstant.toISOString();
  const applicationTimezone = getApplicationTimezone();
  const promptText = buildTextMessagePrompt(
    trimmedUserMessage,
    currentTransactionTimestampIso,
    applicationTimezone
  );

  return {
    promptText,
    systemInstruction,
    requestContextDescription: `Text message: "${trimmedUserMessage}"`,
  };
}

/**
 * Prepares the prompt and system instruction for receipt vision extraction.
 */
export function prepareReceiptPrompt(
  mimeType: string,
  imageBufferByteLength: number,
  optionalCaption: string,
  availableAccountList: WalletAccountItem[],
  availableCategoryList: WalletCategoryItem[],
  referenceInstant: Date,
  categoryContextService?: CategoryContextService
): PreparedReceiptPrompt {
  const applicationTimezoneIdentifier = getApplicationTimezone();
  const currentDateIso = getCurrentLocalDateString(referenceInstant, applicationTimezoneIdentifier);
  const formattedCategoryContext = categoryContextService?.formatCompactContext(availableCategoryList);
  const systemInstruction = buildReceiptSystemInstruction(
    availableAccountList,
    availableCategoryList,
    currentDateIso,
    applicationTimezoneIdentifier,
    referenceInstant,
    formattedCategoryContext
  );
  const currentTransactionTimestampIso = referenceInstant.toISOString();
  const activeLanguage = getActiveLanguage();
  const localTimeAnchor = formatLocalTimeAnchor(
    referenceInstant,
    applicationTimezoneIdentifier,
    activeLanguage
  );
  const promptText = buildReceiptExtractionPrompt(
    optionalCaption,
    currentTransactionTimestampIso,
    localTimeAnchor
  );

  return {
    promptText,
    systemInstruction,
    requestContextDescription: `Receipt photo message (mime: ${mimeType}, size: ${imageBufferByteLength} bytes, caption: "${optionalCaption}")`,
  };
}

/**
 * Prepares the prompt and system instruction for bank notification email evaluation.
 */
export function prepareEmailEvaluationPrompt(
  gateResult: GateEvaluationResult,
  emailSubject: string,
  emailSender: string,
  emailBodyText: string,
  emailDate: Date,
  availableAccountList: WalletAccountItem[],
  availableCategoryList: WalletCategoryItem[],
  categoryContextService?: CategoryContextService
): PreparedEmailPrompt {
  const formattedCategoryContext = categoryContextService?.formatCompactContext(availableCategoryList);
  const systemInstruction = buildEmailSystemInstruction(
    availableAccountList,
    availableCategoryList,
    formattedCategoryContext
  );
  const promptText = buildEmailEvaluationPrompt(gateResult, emailSubject, emailSender, emailBodyText, emailDate);

  return {
    promptText,
    systemInstruction,
    requestContextDescription: `Email transaction parsing: "${emailSubject}" from ${emailSender}`,
  };
}
