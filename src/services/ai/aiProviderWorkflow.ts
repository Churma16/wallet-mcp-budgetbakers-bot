import { WalletAccountItem, WalletCategoryItem } from '../../types/walletTypes.js';
import { GateEvaluationResult } from '../../utils/emailGateEvaluator.js';
import { applicationLogger } from '../../utils/logger.js';
import {
  ExtractedFinancialIntent,
  ExtractedEmailTransactionData,
  TokenUsageStatistics,
} from './financialAiProvider.js';
import {
  extractAndParseJsonObject,
  validateReceiptFinancialIntentEnvelope,
} from './jsonExtractionHelper.js';
import { getActiveLanguage } from '../../i18n/index.js';
import { getApplicationTimezone } from '../../utils/humanResponseFormatter.js';
import {
  getCurrentLocalDateString,
  getTimezoneOffsetDetails,
} from '../../utils/relativeTimeParser.js';
import {
  buildCompactSystemInstruction,
  buildReceiptSystemInstruction,
  buildEmailSystemInstruction,
  buildTextMessagePrompt,
  buildReceiptExtractionPrompt,
  buildEmailEvaluationPrompt,
  resolveEmailExtractedEntities,
  buildFailedEmailTransactionFallback,
} from './aiPromptBuilder.js';
import { CategoryContextService } from '../categoryContextService.js';

export interface AiExecutionResult {
  responseText: string;
  tokenUsage?: TokenUsageStatistics;
}

export interface PreparedTextMessagePrompt {
  promptText: string;
  systemInstruction: string;
  requestContextDescription: string;
}

export interface PreparedReceiptPrompt {
  promptText: string;
  systemInstruction: string;
  requestContextDescription: string;
}

export interface PreparedEmailPrompt {
  promptText: string;
  systemInstruction: string;
  requestContextDescription: string;
}

/**
 * Reusable system instruction compiler and cache key manager.
 * Caches compiled compact system instructions based on language, local date,
 * application timezone, offset, account IDs, category IDs, and category context fingerprint.
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
    const cacheKey = `${activeLanguage}|${currentDateIso}|${applicationTimezone}|${timezoneOffsetDetails.formattedOffset}|${availableAccountList.map(account => account.id).join(',')}|${availableCategoryList.map(category => category.id).join(',')}|${contextFingerprint}`;

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
  const promptText = buildReceiptExtractionPrompt(optionalCaption, currentTransactionTimestampIso);

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

/**
 * Post-processes an AI response for text financial intent extraction.
 * Robustly parses the JSON object, attaches token usage metadata, and falls back to GENERAL_REPLY on parse failures.
 */
export function postProcessFinancialIntentResponse(
  executionResult: AiExecutionResult,
  providerLabel: string
): ExtractedFinancialIntent {
  try {
    const parsedIntent = extractAndParseJsonObject<ExtractedFinancialIntent>(executionResult.responseText);
    parsedIntent.tokenUsage = executionResult.tokenUsage;
    applicationLogger.fileDetail('ai', `Parsed Financial Intent from ${providerLabel}`, parsedIntent);
    return parsedIntent;
  } catch {
    return {
      action: 'GENERAL_REPLY',
      explanation: executionResult.responseText,
      tokenUsage: executionResult.tokenUsage,
    };
  }
}

/**
 * Post-processes an AI response for receipt vision extraction.
 * Extracts the JSON object, validates the intent envelope, and attaches token usage.
 */
export function postProcessReceiptVisionResponse(
  executionResult: AiExecutionResult,
  providerLabel: string
): ExtractedFinancialIntent {
  const parsedJsonObject = extractAndParseJsonObject<unknown>(executionResult.responseText);
  const parsedIntent = validateReceiptFinancialIntentEnvelope(parsedJsonObject, executionResult.responseText);
  parsedIntent.tokenUsage = executionResult.tokenUsage;
  applicationLogger.fileDetail('ai', `Parsed Financial Intent from ${providerLabel} Vision`, parsedIntent);
  return parsedIntent;
}

/**
 * Post-processes an AI response for email transaction parsing.
 * Extracts JSON data, resolves account/category entities, and builds a fallback item on parse errors.
 */
export function postProcessEmailTransactionResponse(
  executionResult: AiExecutionResult,
  gateResult: GateEvaluationResult,
  emailSubject: string,
  emailDate: Date,
  availableAccountList: WalletAccountItem[],
  availableCategoryList: WalletCategoryItem[],
  providerLabel: string
): ExtractedEmailTransactionData {
  try {
    const parsedData = extractAndParseJsonObject<ExtractedEmailTransactionData>(executionResult.responseText);
    parsedData.tokenUsage = executionResult.tokenUsage;

    return resolveEmailExtractedEntities(
      parsedData,
      gateResult,
      emailSubject,
      emailDate,
      availableAccountList,
      availableCategoryList
    );
  } catch {
    return buildFailedEmailTransactionFallback(
      gateResult,
      emailSubject,
      emailDate,
      `Failed to parse JSON response from ${providerLabel} for email transaction`,
      executionResult.tokenUsage
    );
  }
}

/**
 * Checks whether an encountered error during model execution is recoverable and eligible for candidate model fallback.
 */
export function isRecoverableModelExecutionError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const rawErrorMessage = error instanceof Error
    ? `${error.message} ${String((error as any)?.response?.data?.error?.message || '')}`
    : String(error);

  const normalizedErrorMessage = rawErrorMessage.toLowerCase();
  const httpStatus = (error as any)?.response?.status || (error as any)?.status;

  if (
    httpStatus === 429 ||
    httpStatus === 503 ||
    httpStatus === 504 ||
    httpStatus === 500 ||
    httpStatus === 502 ||
    httpStatus === 404
  ) {
    return true;
  }

  return (
    rawErrorMessage.includes('DEADLINE_EXCEEDED') ||
    rawErrorMessage.includes('UNAVAILABLE') ||
    rawErrorMessage.includes('RESOURCE_EXHAUSTED') ||
    rawErrorMessage.includes('NOT_FOUND') ||
    rawErrorMessage.includes('ECONNABORTED') ||
    normalizedErrorMessage.includes('504') ||
    normalizedErrorMessage.includes('503') ||
    normalizedErrorMessage.includes('429') ||
    normalizedErrorMessage.includes('404') ||
    normalizedErrorMessage.includes('500') ||
    normalizedErrorMessage.includes('502') ||
    normalizedErrorMessage.includes('high demand') ||
    normalizedErrorMessage.includes('rate limit') ||
    normalizedErrorMessage.includes('too many requests') ||
    normalizedErrorMessage.includes('overloaded') ||
    normalizedErrorMessage.includes('service unavailable') ||
    normalizedErrorMessage.includes('resource_exhausted') ||
    normalizedErrorMessage.includes('quota') ||
    normalizedErrorMessage.includes('time') ||
    normalizedErrorMessage.includes('timeout') ||
    normalizedErrorMessage.includes('deadline') ||
    normalizedErrorMessage.includes('abort') ||
    normalizedErrorMessage.includes('econnaborted')
  );
}

/**
 * Orchestrates text message financial intent extraction end-to-end using a provider-specific transport callback.
 */
export async function executeTextWorkflow(
  options: {
    userMessageText: string;
    availableAccountList: WalletAccountItem[];
    availableCategoryList: WalletCategoryItem[];
    referenceInstant?: Date;
    systemInstructionCache: SystemInstructionCache;
    providerLabel: string;
  },
  transport: (prepared: PreparedTextMessagePrompt) => Promise<AiExecutionResult>
): Promise<ExtractedFinancialIntent> {
  const referenceDate = options.referenceInstant || new Date();
  const prepared = prepareTextMessagePrompt(
    options.userMessageText,
    options.availableAccountList,
    options.availableCategoryList,
    referenceDate,
    options.systemInstructionCache
  );
  const executionResult = await transport(prepared);
  return postProcessFinancialIntentResponse(executionResult, options.providerLabel);
}

/**
 * Orchestrates receipt vision extraction end-to-end using a provider-specific transport callback.
 */
export async function executeReceiptWorkflow(
  options: {
    imageBuffer: Buffer;
    mimeType: string;
    optionalCaption: string;
    availableAccountList: WalletAccountItem[];
    availableCategoryList: WalletCategoryItem[];
    referenceInstant?: Date;
    categoryContextService?: CategoryContextService;
    providerLabel: string;
  },
  transport: (prepared: PreparedReceiptPrompt) => Promise<AiExecutionResult>
): Promise<ExtractedFinancialIntent> {
  const referenceDate = options.referenceInstant || new Date();
  const prepared = prepareReceiptPrompt(
    options.mimeType,
    options.imageBuffer.length,
    options.optionalCaption,
    options.availableAccountList,
    options.availableCategoryList,
    referenceDate,
    options.categoryContextService
  );
  const executionResult = await transport(prepared);
  return postProcessReceiptVisionResponse(executionResult, options.providerLabel);
}

/**
 * Orchestrates bank notification email evaluation end-to-end using a provider-specific transport callback.
 */
export async function executeEmailTransactionWorkflow(
  options: {
    gateResult: GateEvaluationResult;
    emailSubject: string;
    emailSender: string;
    emailBodyText: string;
    emailDate: Date;
    availableAccountList: WalletAccountItem[];
    availableCategoryList: WalletCategoryItem[];
    categoryContextService?: CategoryContextService;
    providerLabel: string;
  },
  transport: (prepared: PreparedEmailPrompt) => Promise<AiExecutionResult>
): Promise<ExtractedEmailTransactionData> {
  const prepared = prepareEmailEvaluationPrompt(
    options.gateResult,
    options.emailSubject,
    options.emailSender,
    options.emailBodyText,
    options.emailDate,
    options.availableAccountList,
    options.availableCategoryList,
    options.categoryContextService
  );
  const executionResult = await transport(prepared);
  return postProcessEmailTransactionResponse(
    executionResult,
    options.gateResult,
    options.emailSubject,
    options.emailDate,
    options.availableAccountList,
    options.availableCategoryList,
    options.providerLabel
  );
}
