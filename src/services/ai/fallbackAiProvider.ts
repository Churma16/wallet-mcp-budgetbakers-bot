import {
  FinancialAiProvider,
  ExtractedFinancialIntent,
  ExtractedEmailTransactionData,
} from './financialAiProvider.js';
import { WalletAccountItem, WalletCategoryItem } from '../../types/walletTypes.js';
import { GateEvaluationResult } from '../../utils/emailGateEvaluator.js';
import { applicationLogger, formatConciseErrorMessage } from '../../utils/logger.js';

/**
 * Checks whether an error is a recoverable provider-level failure eligible for failover
 * (e.g. rate limit, quota exhaustion, service outage, temporary gateway errors)
 */
export function isRecoverableProviderError(error: unknown): boolean {
  if (!error) {
    return false;
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
 * FallbackAiProvider coordinates multiple FinancialAiProvider instances in priority order.
 * If a provider encounters a recoverable error (rate limit, outage, quota exhaustion),
 * it seamlessly cascades execution to the next configured provider in line.
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

  /**
   * Processes a natural language text message with cross-provider fallback
   */
  public async processTextMessage(
    userMessageText: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[]
  ): Promise<ExtractedFinancialIntent> {
    return this.executeWithFallback(
      'processTextMessage',
      async (currentProvider: FinancialAiProvider) =>
        currentProvider.processTextMessage(userMessageText, availableAccountList, availableCategoryList)
    );
  }

  /**
   * Processes a receipt or invoice image with cross-provider fallback
   */
  public async processImageMessage(
    imageBuffer: Buffer,
    mimeType: string,
    optionalCaption: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[]
  ): Promise<ExtractedFinancialIntent> {
    return this.executeWithFallback(
      'processImageMessage',
      async (currentProvider: FinancialAiProvider) =>
        currentProvider.processImageMessage(
          imageBuffer,
          mimeType,
          optionalCaption,
          availableAccountList,
          availableCategoryList
        )
    );
  }

  /**
   * Processes an email transaction message with cross-provider fallback
   */
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

  /**
   * Generic execution wrapper iterating through providers in priority sequence
   */
  private async executeWithFallback<T>(
    operationName: string,
    operationHandler: (provider: FinancialAiProvider) => Promise<T>
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
          continue;
        }

        if (hasNextProvider) {
          const nextProvider = this.orderedProviderList[providerIndex + 1];
          applicationLogger.warn(
            `Provider '${currentProvider.providerName}' encountered error during '${operationName}' (${conciseErrorMessage}). Attempting failover to '${nextProvider.providerName}'...`
          );
          continue;
        }

        throw error;
      }
    }

    throw lastEncounteredError || new Error(`All configured AI providers failed for operation '${operationName}'.`);
  }
}
