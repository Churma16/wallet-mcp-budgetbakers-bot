import { WalletAccountItem, WalletCategoryItem } from '../../types/walletTypes.js';
import { GateEvaluationResult } from '../../utils/emailGateEvaluator.js';
import { applicationLogger } from '../../utils/logger.js';
import {
  ExtractedFinancialIntent,
  ExtractedEmailTransactionData,
  TokenUsageStatistics,
  SemanticHistoryQueryResult,
} from './financialAiProvider.js';
import {
  extractAndParseJsonObject,
  validateReceiptFinancialIntentEnvelope,
} from './jsonExtractionHelper.js';
import { getActiveLanguage } from '../../i18n/index.js';
import { getApplicationTimezone } from '../../config/applicationConfig.js';
import {
  getCurrentLocalDateString,
  getTimezoneOffsetDetails,
  formatLocalTimeAnchor,
} from '../../utils/relativeTimeParser.js';
import {
  buildCompactSystemInstruction,
  buildReceiptSystemInstruction,
  buildEmailSystemInstruction,
  buildTextMessagePrompt,
  buildReceiptExtractionPrompt,
  buildEmailEvaluationPrompt,
  buildSemanticHistoryQueryPrompt,
  buildSemanticHistorySystemInstruction,
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

export interface PreparedSemanticHistoryPrompt {
  promptText: string;
  systemInstruction: string;
  requestContextDescription: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateSemanticHistoryQueryResponse(
  value: unknown,
  tokenUsage?: TokenUsageStatistics
): SemanticHistoryQueryResult {
  if (!isPlainObject(value) || !['query', 'clarification', 'not_history'].includes(String(value.status))) {
    throw new Error('Invalid semantic history response status.');
  }
  if (value.status === 'not_history') return { status: 'not_history', tokenUsage };
  if (value.status === 'clarification') {
    if (typeof value.clarification !== 'string' || !value.clarification.trim() || value.clarification.length > 300) {
      throw new Error('Invalid semantic history clarification.');
    }
    return { status: 'clarification', clarification: value.clarification.trim(), tokenUsage };
  }
  if (!isPlainObject(value.queryOptions)) throw new Error('Invalid semantic history query options.');

  const allowedKeys = new Set(['accountName', 'categoryName', 'recordType', 'startDate', 'endDate', 'datePeriod', 'searchQuery', 'limit', 'page', 'sort']);
  for (const key of Object.keys(value.queryOptions)) {
    if (!allowedKeys.has(key)) throw new Error(`Unsupported semantic history query field '${key}'.`);
  }
  const options = value.queryOptions;
  const stringFields = ['accountName', 'categoryName', 'startDate', 'endDate', 'searchQuery'] as const;
  for (const field of stringFields) {
    if (options[field] !== undefined && (typeof options[field] !== 'string' || !(options[field] as string).trim() || (options[field] as string).length > 200)) {
      throw new Error(`Invalid semantic history field '${field}'.`);
    }
  }
  if (options.recordType !== undefined && !['expense', 'income'].includes(String(options.recordType))) throw new Error('Invalid semantic history record type.');
  if (options.datePeriod !== undefined && !['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_year'].includes(String(options.datePeriod))) throw new Error('Invalid semantic history date period.');
  if (options.sort !== undefined && !['newest', 'oldest'].includes(String(options.sort))) throw new Error('Invalid semantic history sort.');
  for (const field of ['limit', 'page'] as const) {
    if (options[field] !== undefined && (!Number.isInteger(options[field]) || Number(options[field]) <= 0)) throw new Error(`Invalid semantic history field '${field}'.`);
  }
  return { status: 'query', queryOptions: { ...options }, tokenUsage } as SemanticHistoryQueryResult;
}

export function prepareSemanticHistoryPrompt(
  userMessageText: string,
  availableAccountList: WalletAccountItem[],
  availableCategoryList: WalletCategoryItem[],
  referenceInstant: Date
): PreparedSemanticHistoryPrompt {
  const timezone = getApplicationTimezone();
  return {
    systemInstruction: buildSemanticHistorySystemInstruction(
      availableAccountList,
      availableCategoryList,
      getCurrentLocalDateString(referenceInstant, timezone),
      timezone
    ),
    promptText: buildSemanticHistoryQueryPrompt(userMessageText),
    requestContextDescription: 'Read-only semantic transaction-history parsing',
  };
}

export async function executeSemanticHistoryWorkflow(
  options: {
    userMessageText: string;
    availableAccountList: WalletAccountItem[];
    availableCategoryList: WalletCategoryItem[];
    referenceInstant?: Date;
  },
  transport: (prepared: PreparedSemanticHistoryPrompt) => Promise<AiExecutionResult>
): Promise<SemanticHistoryQueryResult> {
  const prepared = prepareSemanticHistoryPrompt(
    options.userMessageText,
    options.availableAccountList,
    options.availableCategoryList,
    options.referenceInstant || new Date()
  );
  const result = await transport(prepared);
  return validateSemanticHistoryQueryResponse(extractAndParseJsonObject<unknown>(result.responseText), result.tokenUsage);
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
    httpStatus === 408 ||
    httpStatus === 429 ||
    httpStatus === 503 ||
    httpStatus === 504 ||
    httpStatus === 500 ||
    httpStatus === 502 ||
    httpStatus === 404
  ) {
    return true;
  }

  // Reject deterministic client errors (e.g. 400 Bad Request, 422 Unprocessable Entity)
  if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500) {
    return false;
  }

  const transientExecutionPatterns = [
    'deadline_exceeded',
    'unavailable',
    'resource_exhausted',
    'not_found',
    'econnaborted',
    'econnreset',
    '504',
    '503',
    '429',
    '408',
    '404',
    '500',
    '502',
    'high demand',
    'rate limit',
    'too many requests',
    'overloaded',
    'service unavailable',
    'quota',
    'timeout',
    'timed out',
    'deadline',
    'abort',
  ];

  return transientExecutionPatterns.some(pattern => normalizedErrorMessage.includes(pattern));
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
