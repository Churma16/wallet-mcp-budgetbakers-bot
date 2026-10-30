import { WalletAccountItem, WalletCategoryItem } from '../wallet/index.js';
import { GateEvaluationResult } from '../utils/emailGateEvaluator.js';
import { applicationLogger } from '../utils/logger.js';
import {
  ExtractedFinancialIntent,
  ExtractedEmailTransactionData,
  AiExecutionResult,
  PreparedTextMessagePrompt,
  PreparedReceiptPrompt,
  PreparedEmailPrompt,
} from './types.js';
import {
  extractAndParseJsonObject,
  validateReceiptFinancialIntentEnvelope,
  AiResponseParseError,
  isAiResponseParseError,
} from './jsonExtraction.js';
import {
  resolveEmailExtractedEntities,
} from './prompts.js';
import { CategoryContextService } from '../services/categoryContextService.js';
import {
  SystemInstructionCache,
  prepareTextMessagePrompt,
  prepareReceiptPrompt,
  prepareEmailEvaluationPrompt,
} from './promptPreparation.js';

export * from './promptPreparation.js';

/**
 * Post-processes an AI response for text financial intent extraction.
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
  let parsedData: ExtractedEmailTransactionData;
  try {
    parsedData = extractAndParseJsonObject<ExtractedEmailTransactionData>(executionResult.responseText);
  } catch (parseError) {
    throw new AiResponseParseError(
      `Failed to parse JSON response from ${providerLabel} for email transaction: ${
        parseError instanceof Error ? parseError.message : String(parseError)
      }`,
      executionResult.responseText
    );
  }

  if (!parsedData || typeof parsedData !== 'object' || typeof parsedData.isTransaction !== 'boolean') {
    throw new AiResponseParseError(
      `AI response from ${providerLabel} is missing required 'isTransaction' boolean field`,
      executionResult.responseText
    );
  }

  parsedData.tokenUsage = executionResult.tokenUsage;

  return resolveEmailExtractedEntities(
    parsedData,
    gateResult,
    emailSubject,
    emailDate,
    availableAccountList,
    availableCategoryList
  );
}

/**
 * Checks whether an encountered error during model execution is recoverable and eligible for candidate model fallback.
 */
export function isRecoverableModelExecutionError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if (isAiResponseParseError(error)) {
    return true;
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
