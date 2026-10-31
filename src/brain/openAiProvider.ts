import { AxiosInstance } from 'axios';
import { WalletAccountItem, WalletCategoryItem } from '../wallet/index.js';
import { GateEvaluationResult } from '../email/index.js';
import { applicationLogger } from '../utils/logger.js';
import {
  FinancialAiProvider,
  ExtractedFinancialIntent,
  ExtractedEmailTransactionData,
  TokenUsageStatistics,
  AccountClarificationQuestionContext,
  AccountClarificationProposal,
  UnifiedClarificationCandidate,
} from './types.js';
import {
  isAiResponseParseError,
  parseClarificationQuestionResponse,
  parseClarificationProposalResponse,
} from './jsonExtraction.js';
import { CategoryContextService } from '../services/categoryContextService.js';
import {
  buildAccountClarificationQuestionPrompt,
  buildAccountClarificationReplyPrompt,
} from './prompts.js';
import {
  SystemInstructionCache,
  executeTextWorkflow,
  executeReceiptWorkflow,
  executeEmailTransactionWorkflow,
} from './providerWorkflow.js';
import {
  OpenAiCompatibleProviderConfiguration,
  createOpenAiHttpClient,
  executeChatCompletionWithFallback,
} from './openAiClient.js';

export type { OpenAiCompatibleProviderConfiguration };

/**
 * AI Provider implementation for OpenAI-compatible REST APIs.
 *
 * Core Purpose & Responsibility:
 * Handles financial intent parsing, receipt vision extraction, email evaluation, and clarification
 * against OpenAI chat completion endpoints (e.g. Groq, DeepSeek, Ollama, OpenRouter).
 *
 * Architectural Role:
 * Implements the FinancialAiProvider interface using Axios HTTP client, supporting candidate model
 * fallbacks, system instruction compiling, and structured JSON extraction.
 */
export class OpenAiCompatibleAiProvider implements FinancialAiProvider {
  public readonly providerName: string;
  private readonly httpClient: AxiosInstance;
  private readonly candidateModelList: string[];
  private readonly requestTimeoutMilliseconds: number;
  private readonly categoryContextService?: CategoryContextService;
  private readonly systemInstructionCache: SystemInstructionCache;

  constructor(configuration: OpenAiCompatibleProviderConfiguration) {
    this.providerName = configuration.providerName || 'openai-compatible';
    this.requestTimeoutMilliseconds = configuration.requestTimeoutMilliseconds || 25000;
    this.categoryContextService = configuration.categoryContextService;
    this.systemInstructionCache = new SystemInstructionCache(configuration.categoryContextService);
    this.candidateModelList = Array.from(
      new Set([configuration.primaryModelName, ...(configuration.fallbackModelList || [])])
    );
    this.httpClient = createOpenAiHttpClient(
      configuration.baseUrl,
      configuration.apiKey,
      this.requestTimeoutMilliseconds
    );
  }

  private executeChatCompletion(
    messages: Array<Record<string, unknown>>,
    requestContextDescription?: string,
    enforceJsonResponseFormat: boolean = true
  ) {
    return executeChatCompletionWithFallback(
      this.httpClient,
      this.candidateModelList,
      this.providerName,
      this.requestTimeoutMilliseconds,
      messages,
      requestContextDescription,
      enforceJsonResponseFormat
    );
  }

  public async processTextMessage(
    userMessageText: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[],
    referenceInstant: Date = new Date()
  ): Promise<ExtractedFinancialIntent> {
    return executeTextWorkflow(
      {
        userMessageText,
        availableAccountList,
        availableCategoryList,
        referenceInstant,
        systemInstructionCache: this.systemInstructionCache,
        providerLabel: this.providerName,
      },
      (prepared) => {
        const messages = [
          { role: 'system', content: prepared.systemInstruction },
          { role: 'user', content: prepared.promptText },
        ];
        return this.executeChatCompletion(messages, prepared.requestContextDescription, true);
      }
    );
  }

  public async processImageMessage(
    imageBuffer: Buffer,
    mimeType: string,
    optionalCaption: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[],
    referenceInstant: Date = new Date()
  ): Promise<ExtractedFinancialIntent> {
    try {
      return await executeReceiptWorkflow(
        {
          imageBuffer,
          mimeType,
          optionalCaption,
          availableAccountList,
          availableCategoryList,
          referenceInstant,
          categoryContextService: this.categoryContextService,
          providerLabel: this.providerName,
        },
        (prepared) => {
          const base64ImageUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
          const messages = [
            { role: 'system', content: prepared.systemInstruction },
            {
              role: 'user',
              content: [
                { type: 'text', text: prepared.promptText },
                {
                  type: 'image_url',
                  image_url: { url: base64ImageUrl },
                },
              ],
            },
          ];
          return this.executeChatCompletion(messages, prepared.requestContextDescription, true);
        }
      );
    } catch (visionError: any) {
      if (isAiResponseParseError(visionError)) {
        throw visionError;
      }
      const errorMessage = visionError?.message || String(visionError);
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
          explanation: `Model '${this.candidateModelList[0]}' yang Anda gunakan saat ini belum mendukung pembacaan gambar / foto struk. Silakan gunakan model multimodal (contoh: openrouter/free di OpenRouter atau aktifkan AI_PROVIDER=gemini).`,
        };
      }
      throw visionError;
    }
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
    return executeEmailTransactionWorkflow(
      {
        gateResult,
        emailSubject,
        emailSender,
        emailBodyText,
        emailDate,
        availableAccountList,
        availableCategoryList,
        categoryContextService: this.categoryContextService,
        providerLabel: this.providerName,
      },
      (prepared) => {
        const messages = [
          { role: 'system', content: prepared.systemInstruction },
          { role: 'user', content: prepared.promptText },
        ];
        return this.executeChatCompletion(messages, prepared.requestContextDescription, true);
      }
    );
  }

  public async generateAccountClarificationQuestion(
    context: AccountClarificationQuestionContext
  ): Promise<{ question: string; tokenUsage?: TokenUsageStatistics }> {
    const { systemInstruction, promptText } = buildAccountClarificationQuestionPrompt(context);
    const messages = [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: promptText },
    ];
    const result = await this.executeChatCompletion(
      messages,
      `Account clarification question for draft #${context.ticketId}`
    );

    return parseClarificationQuestionResponse(result.responseText, result.tokenUsage);
  }

  public async interpretAccountClarificationReply(
    userReplyText: string,
    candidates: UnifiedClarificationCandidate[],
    context?: Partial<AccountClarificationQuestionContext>
  ): Promise<AccountClarificationProposal> {
    const { systemInstruction, promptText } = buildAccountClarificationReplyPrompt(
      userReplyText,
      candidates,
      context as any
    );
    const messages = [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: promptText },
    ];
    const result = await this.executeChatCompletion(
      messages,
      `Account clarification interpretation for draft #${context?.ticketId ?? 'unknown'}`
    );

    return parseClarificationProposalResponse(result.responseText, result.tokenUsage);
  }
}
