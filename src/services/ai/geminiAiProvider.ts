import { GoogleGenAI } from '@google/genai';
import { WalletAccountItem, WalletCategoryItem } from '../../types/walletTypes.js';
import { GateEvaluationResult } from '../../utils/emailGateEvaluator.js';
import { applicationLogger, formatConciseErrorMessage } from '../../utils/logger.js';
import {
  FinancialAiProvider,
  ExtractedFinancialIntent,
  ExtractedEmailTransactionData,
  TokenUsageStatistics,
} from './financialAiProvider.js';
import { extractAndParseJsonObject, validateReceiptFinancialIntentEnvelope } from './jsonExtractionHelper.js';
import { getActiveLanguage } from '../../i18n/index.js';

import { getApplicationTimezone } from '../../utils/humanResponseFormatter.js';
import { getCurrentLocalDateString, getTimezoneOffsetDetails } from '../../utils/relativeTimeParser.js';
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

interface GenerationExecutionResult {
  responseText: string;
  tokenUsage?: TokenUsageStatistics;
}

export class GeminiAiProvider implements FinancialAiProvider {
  public readonly providerName: string = 'gemini';

  private readonly googleGenAiClient: GoogleGenAI;
  private readonly candidateModelList: string[];

  private cachedSystemInstruction: string = '';
  private systemInstructionCacheKey: string = '';

  constructor(
    apiKey: string,
    primaryModelName: string = process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    fallbackModelList: string[] = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'],
    private readonly requestTimeoutMilliseconds: number = 20000,
    private readonly categoryContextService?: CategoryContextService
  ) {
    this.googleGenAiClient = new GoogleGenAI({ apiKey });
    this.candidateModelList = Array.from(new Set([primaryModelName, ...fallbackModelList]));
  }

  /**
   * Retrieves cached system instruction or compiles a new compact version if accounts or date changed
   */
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

  public getSystemInstructionCacheKey(): string {
    return this.systemInstructionCacheKey;
  }

  /**
   * Helper to sanitize request contents before logging to prevent flooding logs with base64 strings
   */
  private sanitizeContentsForLogging(contents: any): any {
    if (!contents || !Array.isArray(contents)) {
      return contents;
    }

    return contents.map(contentItem => {
      if (typeof contentItem === 'object' && contentItem !== null && Array.isArray((contentItem as any).parts)) {
        const sanitizedParts = (contentItem as any).parts.map((partItem: any) => {
          if (partItem && typeof partItem === 'object' && partItem.inlineData) {
            const dataLength = partItem.inlineData.data ? String(partItem.inlineData.data).length : 0;
            return {
              ...partItem,
              inlineData: {
                mimeType: partItem.inlineData.mimeType,
                data: `[BASE64_IMAGE_DATA_OMITTED - length: ${dataLength} characters]`,
              },
            };
          }
          return partItem;
        });

        return {
          ...contentItem,
          parts: sanitizedParts,
        };
      }
      return contentItem;
    });
  }

  /**
   * Executes content generation with automatic multi-model failover on 503 (High demand) or 429 (Rate limit)
   */
  private async executeGenerationWithFallback(
    generationRequestOptions: {
      contents: Parameters<GoogleGenAI['models']['generateContent']>[0]['contents'];
      systemInstruction: string;
      requestContextDescription?: string;
    }
  ): Promise<GenerationExecutionResult> {
    let lastEncounteredError: unknown = null;

    for (let modelIndex = 0; modelIndex < this.candidateModelList.length; modelIndex++) {
      const currentCandidateModel = this.candidateModelList[modelIndex];
      const startExecutionTimestamp = Date.now();

      applicationLogger.fileDetail('ai', `Dispatched Gemini Request [${currentCandidateModel}]`, {
        model: currentCandidateModel,
        context: generationRequestOptions.requestContextDescription || 'General message processing',
        contents: this.sanitizeContentsForLogging(generationRequestOptions.contents),
      });

      const heartbeatIntervalMilliseconds = 5000;
      const heartbeatTimer = setInterval(() => {
        const elapsedExecutionSeconds = Math.round((Date.now() - startExecutionTimestamp) / 1000);
        applicationLogger.ai(
          `Waiting for Gemini [${currentCandidateModel}] response... (${elapsedExecutionSeconds}s elapsed)`
        );
      }, heartbeatIntervalMilliseconds);

      const abortController = new AbortController();
      const timeoutTimer = setTimeout(() => {
        abortController.abort(new Error(`Request timed out after ${this.requestTimeoutMilliseconds / 1000}s`));
      }, this.requestTimeoutMilliseconds);

      try {
        const generationPromise = this.googleGenAiClient.models.generateContent({
          model: currentCandidateModel,
          contents: generationRequestOptions.contents,
          config: {
            systemInstruction: generationRequestOptions.systemInstruction,
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: 2048,
            httpOptions: {
              timeout: this.requestTimeoutMilliseconds,
            },
            abortSignal: abortController.signal,
          },
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          abortController.signal.addEventListener('abort', () => {
            reject(new Error(`Request timed out after ${this.requestTimeoutMilliseconds / 1000}s`));
          });
        });

        const generationResponse = await Promise.race([generationPromise, timeoutPromise]);

        const executionDurationMilliseconds = Date.now() - startExecutionTimestamp;
        const responseText = generationResponse.text || '{}';
        const usageMetadata = (generationResponse as any).usageMetadata;

        const promptTokens = usageMetadata?.promptTokenCount ?? 0;
        const candidatesTokens = usageMetadata?.candidatesTokenCount ?? 0;
        const totalTokens = usageMetadata?.totalTokenCount ?? (promptTokens + candidatesTokens);

        applicationLogger.ai(
          `Gemini [${currentCandidateModel}] responded in ${executionDurationMilliseconds}ms | Tokens: ${totalTokens} (Prompt: ${promptTokens}, Output: ${candidatesTokens})`
        );

        const tokenUsage: TokenUsageStatistics = {
          promptTokens,
          candidatesTokens,
          totalTokens,
          cachedContentTokens: usageMetadata?.cachedContentTokenCount ?? 0,
          thoughtsTokens: usageMetadata?.thoughtsTokenCount ?? 0,
        };

        applicationLogger.fileDetail('ai', `Received Gemini Response [${currentCandidateModel}] (${executionDurationMilliseconds}ms)`, {
          model: currentCandidateModel,
          latencyMilliseconds: executionDurationMilliseconds,
          tokenUsage,
          rawResponse: responseText,
        });

        return {
          responseText,
          tokenUsage,
        };
      } catch (error: unknown) {
        lastEncounteredError = error;
        const executionDurationMilliseconds = Date.now() - startExecutionTimestamp;
        const errorMessage = error instanceof Error ? error.message : String(error);

        const isRecoverableModelError =
          errorMessage.includes('504') ||
          errorMessage.includes('503') ||
          errorMessage.includes('429') ||
          errorMessage.includes('404') ||
          errorMessage.includes('500') ||
          errorMessage.includes('DEADLINE_EXCEEDED') ||
          errorMessage.includes('high demand') ||
          errorMessage.includes('UNAVAILABLE') ||
          errorMessage.includes('RESOURCE_EXHAUSTED') ||
          errorMessage.includes('NOT_FOUND') ||
          errorMessage.includes('overloaded') ||
          errorMessage.toLowerCase().includes('time') ||
          errorMessage.toLowerCase().includes('deadline') ||
          errorMessage.toLowerCase().includes('abort');

        const hasNextFallbackModel = modelIndex + 1 < this.candidateModelList.length;

        applicationLogger.fileDetail('error', `Gemini Model Execution Failed [${currentCandidateModel}] (${executionDurationMilliseconds}ms)`, {
          model: currentCandidateModel,
          duration: `${executionDurationMilliseconds}ms`,
          errorMessage,
          isRecoverable: isRecoverableModelError,
          hasNextFallback: hasNextFallbackModel,
          errorStack: error instanceof Error ? error.stack : undefined,
        });

        if (isRecoverableModelError && hasNextFallbackModel) {
          const nextCandidateModel = this.candidateModelList[modelIndex + 1];
          const conciseErrorSummary = formatConciseErrorMessage(errorMessage);
          applicationLogger.warn(
            `Model '${currentCandidateModel}' failed (${conciseErrorSummary}). Retrying with fallback model '${nextCandidateModel}'...`
          );
          continue;
        }

        throw error;
      } finally {
        clearInterval(heartbeatTimer);
        clearTimeout(timeoutTimer);
      }
    }

    throw lastEncounteredError || new Error('All candidate Gemini models failed to generate content');
  }

  /**
   * Process incoming text message from user
   */
  public async processTextMessage(
    userMessageText: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[],
    referenceInstant: Date = new Date()
  ): Promise<ExtractedFinancialIntent> {
    const systemInstructionContent = this.getSystemInstruction(
      availableAccountList,
      availableCategoryList,
      referenceInstant
    );

    const trimmedUserMessage = userMessageText.trim();
    const currentTransactionTimestampIso = referenceInstant.toISOString();
    const applicationTimezone = getApplicationTimezone();
    const promptTextWithTimestamp = buildTextMessagePrompt(
      trimmedUserMessage,
      currentTransactionTimestampIso,
      applicationTimezone
    );

    const generationResult = await this.executeGenerationWithFallback({
      contents: [
        {
          role: 'user',
          parts: [{ text: promptTextWithTimestamp }],
        },
      ],
      systemInstruction: systemInstructionContent,
      requestContextDescription: `Text message: "${trimmedUserMessage}"`,
    });

    try {
      const parsedIntent = extractAndParseJsonObject<ExtractedFinancialIntent>(generationResult.responseText);
      parsedIntent.tokenUsage = generationResult.tokenUsage;
      applicationLogger.fileDetail('ai', 'Parsed Financial Intent from Gemini', parsedIntent);
      return parsedIntent;
    } catch {
      return {
        action: 'GENERAL_REPLY',
        explanation: generationResult.responseText,
        tokenUsage: generationResult.tokenUsage,
      };
    }
  }

  /**
   * Process incoming image (e.g. receipt or invoice photo)
   */
  public async processImageMessage(
    imageBuffer: Buffer,
    mimeType: string,
    optionalCaption: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[],
    referenceInstant: Date = new Date()
  ): Promise<ExtractedFinancialIntent> {
    const applicationTimezoneIdentifier = getApplicationTimezone();
    const currentDateIso = getCurrentLocalDateString(referenceInstant, applicationTimezoneIdentifier);
    const formattedCategoryContext = this.categoryContextService?.formatCompactContext(availableCategoryList);
    const systemInstructionContent = buildReceiptSystemInstruction(
      availableAccountList,
      availableCategoryList,
      currentDateIso,
      applicationTimezoneIdentifier,
      referenceInstant,
      formattedCategoryContext
    );
    const currentTransactionTimestampIso = referenceInstant.toISOString();
    const promptText = buildReceiptExtractionPrompt(optionalCaption, currentTransactionTimestampIso);

    const generationResult = await this.executeGenerationWithFallback({
      contents: [
        {
          role: 'user',
          parts: [
            { text: promptText },
            {
              inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType,
              },
            },
          ],
        },
      ],
      systemInstruction: systemInstructionContent,
      requestContextDescription: `Receipt photo message (mime: ${mimeType}, size: ${imageBuffer.length} bytes, caption: "${optionalCaption}")`,
    });

    const parsedJsonObject = extractAndParseJsonObject<unknown>(generationResult.responseText);
    const parsedIntent = validateReceiptFinancialIntentEnvelope(parsedJsonObject, generationResult.responseText);
    parsedIntent.tokenUsage = generationResult.tokenUsage;
    applicationLogger.fileDetail('ai', 'Parsed Financial Intent from Gemini Vision', parsedIntent);
    return parsedIntent;
  }

  /**
   * Process email transaction message through Gate 2 (AI context validation & entity extraction)
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
    const formattedCategoryContext = this.categoryContextService?.formatCompactContext(availableCategoryList);
    const emailSystemInstruction = buildEmailSystemInstruction(
      availableAccountList,
      availableCategoryList,
      formattedCategoryContext
    );
    const promptText = buildEmailEvaluationPrompt(gateResult, emailSubject, emailSender, emailBodyText, emailDate);

    const generationResult = await this.executeGenerationWithFallback({
      contents: [{ role: 'user', parts: [{ text: promptText }] }],
      systemInstruction: emailSystemInstruction,
      requestContextDescription: `Email transaction parsing: "${emailSubject}" from ${emailSender}`,
    });

    try {
      const parsedData = extractAndParseJsonObject<ExtractedEmailTransactionData>(generationResult.responseText);
      parsedData.tokenUsage = generationResult.tokenUsage;

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
        'Failed to parse JSON response from Gemini for email transaction',
        generationResult.tokenUsage
      );
    }
  }
}
