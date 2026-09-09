import axios, { AxiosInstance } from 'axios';
import { WalletAccountItem, WalletCategoryItem } from '../../types/walletTypes.js';
import { GateEvaluationResult } from '../../utils/emailGateEvaluator.js';
import { applicationLogger, formatConciseErrorMessage } from '../../utils/logger.js';
import {
  FinancialAiProvider,
  ExtractedFinancialIntent,
  ExtractedEmailTransactionData,
  TokenUsageStatistics,
} from './financialAiProvider.js';
import { extractAndParseJsonObject } from './jsonExtractionHelper.js';
import { getApplicationTimezone } from '../../utils/humanResponseFormatter.js';
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

export interface OpenAiCompatibleProviderConfiguration {
  providerName?: string;
  baseUrl: string;
  apiKey: string;
  primaryModelName: string;
  fallbackModelList?: string[];
  requestTimeoutMilliseconds?: number;
}

/**
 * Removes trailing slash characters from a base URL using a linear string scan.
 */
function trimTrailingSlashes(inputUrl: string): string {
  let endIndex = inputUrl.length;
  while (endIndex > 0 && inputUrl[endIndex - 1] === '/') {
    endIndex--;
  }
  return inputUrl.slice(0, endIndex);
}

interface ChatCompletionResponsePayload {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface GenerationExecutionResult {
  responseText: string;
  tokenUsage?: TokenUsageStatistics;
}

export class OpenAiCompatibleAiProvider implements FinancialAiProvider {
  public readonly providerName: string;
  private readonly httpClient: AxiosInstance;
  private readonly candidateModelList: string[];
  private readonly requestTimeoutMilliseconds: number;

  constructor(configuration: OpenAiCompatibleProviderConfiguration) {
    this.providerName = configuration.providerName || 'openai-compatible';
    this.requestTimeoutMilliseconds = configuration.requestTimeoutMilliseconds || 25000;
    this.candidateModelList = Array.from(
      new Set([configuration.primaryModelName, ...(configuration.fallbackModelList || [])])
    );

    const authorizationHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/wallet_mcp',
      'X-Title': 'Wallet MCP Bookkeeper',
    };

    if (configuration.apiKey && configuration.apiKey.trim().length > 0) {
      authorizationHeaders.Authorization = `Bearer ${configuration.apiKey.trim()}`;
    }

    this.httpClient = axios.create({
      baseURL: trimTrailingSlashes(configuration.baseUrl),
      headers: authorizationHeaders,
      timeout: this.requestTimeoutMilliseconds,
    });
  }

  /**
   * Dispatches chat completion request across candidate models with automatic fallback on failure
   */
  private async executeChatCompletionWithFallback(
    messages: Array<Record<string, unknown>>,
    requestContextDescription?: string,
    enforceJsonResponseFormat: boolean = true
  ): Promise<GenerationExecutionResult> {
    let lastEncounteredError: unknown = null;

    for (let modelIndex = 0; modelIndex < this.candidateModelList.length; modelIndex++) {
      const currentCandidateModel = this.candidateModelList[modelIndex];
      const startExecutionTimestamp = Date.now();

      applicationLogger.fileDetail('ai', `Dispatched ${this.providerName} Request [${currentCandidateModel}]`, {
        provider: this.providerName,
        model: currentCandidateModel,
        context: requestContextDescription || 'General message processing',
        messagesSummary: `Total messages: ${messages.length}`,
      });

      const heartbeatIntervalMilliseconds = 5000;
      const heartbeatTimer = setInterval(() => {
        const elapsedExecutionSeconds = Math.round((Date.now() - startExecutionTimestamp) / 1000);
        applicationLogger.ai(
          `Waiting for ${this.providerName} [${currentCandidateModel}] response... (${elapsedExecutionSeconds}s elapsed)`
        );
      }, heartbeatIntervalMilliseconds);

      const abortController = new AbortController();
      const timeoutTimer = setTimeout(() => {
        abortController.abort();
      }, this.requestTimeoutMilliseconds);

      try {
        const requestPayload: Record<string, unknown> = {
          model: currentCandidateModel,
          messages,
          temperature: 0.1,
          max_tokens: 2048,
        };

        if (enforceJsonResponseFormat) {
          requestPayload.response_format = { type: 'json_object' };
        }

        let response;
        try {
          response = await this.httpClient.post<ChatCompletionResponsePayload>(
            '/chat/completions',
            requestPayload,
            { signal: abortController.signal }
          );
        } catch (postError: any) {
          // If the model rejects response_format (e.g. 400 Bad Request: 'response_format is not supported'), retry without it
          const status = postError?.response?.status;
          const rawErrorMessage = postError?.response?.data?.error?.message || postError?.message || '';
          if (
            status === 400 &&
            enforceJsonResponseFormat &&
            (rawErrorMessage.includes('response_format') || rawErrorMessage.includes('json_object'))
          ) {
            applicationLogger.warn(
              `Model '${currentCandidateModel}' does not support response_format: json_object. Retrying without parameter...`
            );
            return await this.executeChatCompletionWithFallback(messages, requestContextDescription, false);
          }
          throw postError;
        }

        const executionDurationMilliseconds = Date.now() - startExecutionTimestamp;
        const responseData = response.data;
        const rawContent = responseData.choices?.[0]?.message?.content || '';

        const usageData = responseData.usage;
        const promptTokens = usageData?.prompt_tokens ?? 0;
        const candidatesTokens = usageData?.completion_tokens ?? 0;
        const totalTokens = usageData?.total_tokens ?? (promptTokens + candidatesTokens);

        applicationLogger.ai(
          `${this.providerName} [${currentCandidateModel}] responded in ${executionDurationMilliseconds}ms | Tokens: ${totalTokens} (Prompt: ${promptTokens}, Output: ${candidatesTokens})`
        );

        const tokenUsage: TokenUsageStatistics = {
          promptTokens,
          candidatesTokens,
          totalTokens,
        };

        applicationLogger.fileDetail('ai', `Received ${this.providerName} Response [${currentCandidateModel}] (${executionDurationMilliseconds}ms)`, {
          model: currentCandidateModel,
          latencyMilliseconds: executionDurationMilliseconds,
          tokenUsage,
          rawResponse: rawContent,
        });

        return {
          responseText: rawContent,
          tokenUsage,
        };
      } catch (error: any) {
        lastEncounteredError = error;
        const executionDurationMilliseconds = Date.now() - startExecutionTimestamp;
        const errorMessage = error?.response?.data?.error?.message || error?.message || String(error);

        const isRecoverableModelError =
          errorMessage.includes('503') ||
          errorMessage.includes('429') ||
          errorMessage.includes('404') ||
          errorMessage.includes('500') ||
          errorMessage.includes('high demand') ||
          errorMessage.includes('rate limit') ||
          errorMessage.includes('overloaded') ||
          errorMessage.includes('timeout') ||
          errorMessage.includes('ECONNABORTED');

        const hasNextFallbackModel = modelIndex + 1 < this.candidateModelList.length;

        applicationLogger.fileDetail('error', `${this.providerName} Model Execution Failed [${currentCandidateModel}] (${executionDurationMilliseconds}ms)`, {
          model: currentCandidateModel,
          duration: `${executionDurationMilliseconds}ms`,
          errorMessage,
          isRecoverable: isRecoverableModelError,
          hasNextFallback: hasNextFallbackModel,
        });

        if (isRecoverableModelError && hasNextFallbackModel) {
          const nextCandidateModel = this.candidateModelList[modelIndex + 1];
          const conciseErrorSummary = formatConciseErrorMessage(errorMessage);
          applicationLogger.warn(
            `Model '${currentCandidateModel}' failed (${conciseErrorSummary}). Retrying with fallback model '${nextCandidateModel}'...`
          );
          continue;
        }

        throw new Error(`${this.providerName} error (${currentCandidateModel}): ${errorMessage}`);
      } finally {
        clearInterval(heartbeatTimer);
        clearTimeout(timeoutTimer);
      }
    }

    throw lastEncounteredError || new Error(`All candidate models failed for provider ${this.providerName}`);
  }

  /**
   * Process natural language user message
   */
  public async processTextMessage(
    userMessageText: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[]
  ): Promise<ExtractedFinancialIntent> {
    const currentDateIso = new Date().toISOString().split('T')[0];
    const systemInstruction = buildCompactSystemInstruction(
      availableAccountList,
      availableCategoryList,
      currentDateIso
    );

    const trimmedUserMessage = userMessageText.trim();
    const currentTransactionTimestampIso = new Date().toISOString();
    const promptTextWithTimestamp = buildTextMessagePrompt(trimmedUserMessage, currentTransactionTimestampIso);

    const messages = [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: promptTextWithTimestamp },
    ];

    const generationResult = await this.executeChatCompletionWithFallback(
      messages,
      `Text message: "${trimmedUserMessage}"`
    );

    try {
      const parsedIntent = extractAndParseJsonObject<ExtractedFinancialIntent>(generationResult.responseText);
      parsedIntent.tokenUsage = generationResult.tokenUsage;
      applicationLogger.fileDetail('ai', `Parsed Financial Intent from ${this.providerName}`, parsedIntent);
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
   * Process image message (receipt or invoice photo) using OpenAI-standard image_url format
   */
  public async processImageMessage(
    imageBuffer: Buffer,
    mimeType: string,
    optionalCaption: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[]
  ): Promise<ExtractedFinancialIntent> {
    const currentDateIso = new Date().toISOString().split('T')[0];
    const applicationTimezoneIdentifier = getApplicationTimezone();
    const systemInstruction = buildReceiptSystemInstruction(
      availableAccountList,
      availableCategoryList,
      currentDateIso,
      applicationTimezoneIdentifier
    );

    const currentTransactionTimestampIso = new Date().toISOString();
    const promptText = buildReceiptExtractionPrompt(optionalCaption, currentTransactionTimestampIso);

    const base64ImageUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

    const messages = [
      { role: 'system', content: systemInstruction },
      {
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          {
            type: 'image_url',
            image_url: {
              url: base64ImageUrl,
            },
          },
        ],
      },
    ];

    try {
      const generationResult = await this.executeChatCompletionWithFallback(
        messages,
        `Receipt photo (size: ${imageBuffer.length} bytes, caption: "${optionalCaption}")`
      );

      const parsedIntent = extractAndParseJsonObject<ExtractedFinancialIntent>(generationResult.responseText);
      parsedIntent.tokenUsage = generationResult.tokenUsage;
      applicationLogger.fileDetail('ai', `Parsed Financial Intent from ${this.providerName} Vision`, parsedIntent);
      return parsedIntent;
    } catch (visionError: any) {
      const errorMessage = visionError?.message || String(visionError);
      // If error indicates image or vision is not supported by the model
      if (
        errorMessage.toLowerCase().includes('vision') ||
        errorMessage.toLowerCase().includes('image') ||
        errorMessage.toLowerCase().includes('multimodal') ||
        errorMessage.includes('400')
      ) {
        applicationLogger.warn(
          `Active model does not support image OCR: ${errorMessage}. Returning informative message.`
        );
        return {
          action: 'GENERAL_REPLY',
          explanation: `Model '${this.candidateModelList[0]}' yang Anda gunakan saat ini belum mendukung pembacaan gambar / foto struk. Silakan gunakan model multimodal (contoh: google/gemini-2.0-flash-exp:free di OpenRouter atau aktifkan AI_PROVIDER=gemini).`,
        };
      }
      throw visionError;
    }
  }

  /**
   * Process email transaction message through Gate 2
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
    const emailSystemInstruction = buildEmailSystemInstruction(availableAccountList, availableCategoryList);
    const promptText = buildEmailEvaluationPrompt(gateResult, emailSubject, emailSender, emailBodyText, emailDate);

    const messages = [
      { role: 'system', content: emailSystemInstruction },
      { role: 'user', content: promptText },
    ];

    const generationResult = await this.executeChatCompletionWithFallback(
      messages,
      `Email transaction parsing: "${emailSubject}" from ${emailSender}`
    );

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
        'Failed to parse JSON response for email transaction',
        generationResult.tokenUsage
      );
    }
  }
}
