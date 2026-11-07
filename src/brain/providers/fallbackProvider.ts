import {
  FinancialAiProvider,
  ExtractedFinancialIntent,
  ExtractedEmailTransactionData,
  TokenUsageStatistics,
  AccountClarificationQuestionContext,
  AccountClarificationProposal,
  CategoryClassificationProposal,
  UnifiedClarificationCandidate,
  AiProcessingExecutionOptions,
} from '../types.js';
import { WalletAccountItem, WalletCategoryItem } from '../../wallet/index.js';
import { GateEvaluationResult } from '../../email/index.js';
import { applicationLogger, formatConciseErrorMessage } from '../../lib/logger.js';
import { isAiResponseParseError } from './jsonExtraction.js';

/**
 * Checks whether an error is a recoverable provider-level failure eligible for failover
 * (e.g. rate limit, quota exhaustion, service outage, temporary gateway errors).
 */
export function isRecoverableProviderError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if (isAiResponseParseError(error)) {
    return true;
  }

  const errorMessage = (
    error instanceof Error
      ? error.message + ' ' + String((error as any)?.response?.data?.error?.message || '')
      : String(error)
  ).toLowerCase();

  const httpStatus = (error as any)?.response?.status || (error as any)?.status;

  if (httpStatus === 429 || httpStatus === 503 || httpStatus === 502 || httpStatus === 504) {
    return true;
  }

  return (
    errorMessage.includes('429') ||
    errorMessage.includes('too many requests') ||
    errorMessage.includes('quota') ||
    errorMessage.includes('rate limit') ||
    errorMessage.includes('resource_exhausted') ||
    errorMessage.includes('503') ||
    errorMessage.includes('overloaded') ||
    errorMessage.includes('high demand') ||
    errorMessage.includes('service unavailable') ||
    errorMessage.includes('timeout') ||
    errorMessage.includes('timed out') ||
    errorMessage.includes('econnreset') ||
    errorMessage.includes('econnaborted') ||
    errorMessage.includes('all candidate models failed')
  );
}

/**
 * Coordinates multiple FinancialAiProvider instances in priority order.
 *
 * Core Purpose & Responsibility:
 * If a provider encounters a recoverable error (rate limit, outage, quota exhaustion),
 * it seamlessly cascades execution to the next configured provider in line.
 *
 * Architectural Role:
 * Implements FinancialAiProvider composite pattern, wrapping child providers (e.g. Gemini,
 * OpenAI-compatible) and logging fallback transitions while keeping execution transparent to callers.
 */
export class FallbackAiProvider implements FinancialAiProvider {
  public readonly providerName: string;
  private readonly orderedProviderList: FinancialAiProvider[];

  constructor(providerList: FinancialAiProvider[]) {
    if (!providerList || providerList.length === 0) {
      throw new Error('FallbackAiProvider requires at least one FinancialAiProvider instance.');
    }
    this.orderedProviderList = providerList;
    this.providerName = providerList.map(provider => provider.providerName).join('->');
  }

  public getProviders(): readonly FinancialAiProvider[] {
    return this.orderedProviderList;
  }

  public getPrimaryModel(): string {
    const firstProvider = this.orderedProviderList[0];
    if (firstProvider && typeof firstProvider.getPrimaryModel === 'function') {
      return firstProvider.getPrimaryModel();
    }
    return firstProvider?.providerName || this.providerName;
  }

  public async processTextMessage(
    userMessageText: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[],
    referenceInstant?: Date,
    options?: AiProcessingExecutionOptions
  ): Promise<ExtractedFinancialIntent> {
    return this.executeWithFallback(
      'processTextMessage',
      async (currentProvider: FinancialAiProvider) =>
        currentProvider.processTextMessage(
          userMessageText,
          availableAccountList,
          availableCategoryList,
          referenceInstant,
          options
        ),
      options
    );
  }

  public async processImageMessage(
    imageBuffer: Buffer,
    mimeType: string,
    optionalCaption: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[],
    referenceInstant?: Date,
    options?: AiProcessingExecutionOptions
  ): Promise<ExtractedFinancialIntent> {
    return this.executeWithFallback(
      'processImageMessage',
      async (currentProvider: FinancialAiProvider) =>
        currentProvider.processImageMessage(
          imageBuffer,
          mimeType,
          optionalCaption,
          availableAccountList,
          availableCategoryList,
          referenceInstant,
          options
        ),
      options
    );
  }

  public async processEmailTransactionMessage(
    gateResult: GateEvaluationResult,
    emailSubject: string,
    emailSender: string,
    emailBodyText: string,
    emailDate: Date,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[]
  ): Promise<ExtractedEmailTransactionData> {
    return this.executeWithFallback(
      'processEmailTransactionMessage',
      async (currentProvider: FinancialAiProvider) =>
        currentProvider.processEmailTransactionMessage(
          gateResult,
          emailSubject,
          emailSender,
          emailBodyText,
          emailDate,
          availableAccountList,
          availableCategoryList
        )
    );
  }

  public async generateAccountClarificationQuestion(
    context: AccountClarificationQuestionContext
  ): Promise<{ question: string; tokenUsage?: TokenUsageStatistics }> {
    return this.executeWithFallback(
      'generateAccountClarificationQuestion',
      async (currentProvider: FinancialAiProvider) => {
        if (typeof currentProvider.generateAccountClarificationQuestion !== 'function') {
          throw new Error(
            `Provider '${currentProvider.providerName}' does not implement generateAccountClarificationQuestion.`
          );
        }
        return currentProvider.generateAccountClarificationQuestion(context);
      }
    );
  }

  public async interpretAccountClarificationReply(
    userReplyText: string,
    candidates: UnifiedClarificationCandidate[],
    context?: Partial<AccountClarificationQuestionContext>
  ): Promise<AccountClarificationProposal> {
    return this.executeWithFallback(
      'interpretAccountClarificationReply',
      async (currentProvider: FinancialAiProvider) => {
        if (typeof currentProvider.interpretAccountClarificationReply !== 'function') {
          throw new Error(
            `Provider '${currentProvider.providerName}' does not implement interpretAccountClarificationReply.`
          );
        }
        return currentProvider.interpretAccountClarificationReply(userReplyText, candidates, context);
      }
    );
  }

  public async classifyCategory(
    text: string,
    availableCategoryList: WalletCategoryItem[]
  ): Promise<CategoryClassificationProposal> {
    return this.executeWithFallback(
      'classifyCategory',
      async (currentProvider: FinancialAiProvider) => {
        if (typeof currentProvider.classifyCategory !== 'function') {
          throw new Error(
            `Provider '${currentProvider.providerName}' does not implement classifyCategory.`
          );
        }
        return currentProvider.classifyCategory(text, availableCategoryList);
      }
    );
  }

  private async executeWithFallback<T>(
    operationName: string,
    operationHandler: (provider: FinancialAiProvider) => Promise<T>,
    options?: AiProcessingExecutionOptions
  ): Promise<T> {
    let lastEncounteredError: unknown = null;

    for (let providerIndex = 0; providerIndex < this.orderedProviderList.length; providerIndex++) {
      const currentProvider = this.orderedProviderList[providerIndex];
      const hasNextProvider = providerIndex + 1 < this.orderedProviderList.length;

      try {
        return await operationHandler(currentProvider);
      } catch (error: unknown) {
        lastEncounteredError = error;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const conciseErrorMessage = formatConciseErrorMessage(errorMessage);
        const isRecoverable = isRecoverableProviderError(error);

        applicationLogger.fileDetail('error', `Provider '${currentProvider.providerName}' failed during '${operationName}'`, {
          provider: currentProvider.providerName,
          operationName,
          errorMessage,
          isRecoverable,
          hasNextProvider,
        });

        if (hasNextProvider && isRecoverable) {
          const nextProvider = this.orderedProviderList[providerIndex + 1];
          applicationLogger.warn(
            `Provider '${currentProvider.providerName}' failed during '${operationName}' (${conciseErrorMessage}). Failing over to '${nextProvider.providerName}'...`
          );

          if (options?.onFallback) {
            try {
              await options.onFallback({
                currentModel: currentProvider.providerName,
                nextModel: nextProvider.providerName,
                attemptIndex: providerIndex + 1,
                totalCandidates: this.orderedProviderList.length,
                reason: conciseErrorMessage,
              });
            } catch (callbackError: unknown) {
              applicationLogger.warn(`Provider fallback callback failed: ${callbackError}`);
            }
          }
          continue;
        }

        if (hasNextProvider) {
          const nextProvider = this.orderedProviderList[providerIndex + 1];
          applicationLogger.warn(
            `Provider '${currentProvider.providerName}' encountered error during '${operationName}' (${conciseErrorMessage}). Attempting failover to '${nextProvider.providerName}'...`
          );

          if (options?.onFallback) {
            try {
              await options.onFallback({
                currentModel: currentProvider.providerName,
                nextModel: nextProvider.providerName,
                attemptIndex: providerIndex + 1,
                totalCandidates: this.orderedProviderList.length,
                reason: conciseErrorMessage,
              });
            } catch (callbackError: unknown) {
              applicationLogger.warn(`Provider fallback callback failed: ${callbackError}`);
            }
          }
          continue;
        }

        throw error;
      }
    }

    throw lastEncounteredError || new Error(`All configured AI providers failed for operation '${operationName}'.`);
  }
}
