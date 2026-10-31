import { GoogleGenAI } from '@google/genai';
import { WalletAccountItem, WalletCategoryItem } from '../../wallet/index.js';
import { GateEvaluationResult } from '../../email/index.js';
import {
  FinancialAiProvider,
  ExtractedFinancialIntent,
  ExtractedEmailTransactionData,
  TokenUsageStatistics,
  AccountClarificationQuestionContext,
  AccountClarificationProposal,
  UnifiedClarificationCandidate,
} from '../types.js';
import { CategoryContextService } from '../category/categoryContext.js';
import {
  SystemInstructionCache,
  executeTextWorkflow,
  executeReceiptWorkflow,
  executeEmailTransactionWorkflow,
} from './providerWorkflow.js';
import {
  buildAccountClarificationQuestionPrompt,
  buildAccountClarificationReplyPrompt,
} from '../prompts/prompts.js';
import {
  parseClarificationQuestionResponse,
  parseClarificationProposalResponse,
} from './jsonExtraction.js';
import { executeGeminiGenerationWithFallback } from './geminiClient.js';

/**
 * AI Provider implementation for Google Gemini SDK.
 *
 * Core Purpose & Responsibility:
 * Handles multimodal financial intent parsing, receipt image OCR extraction,
 * transactional email evaluation, and interactive clarification workflows using Google Gemini models.
 *
 * Architectural Role:
 * Implements the FinancialAiProvider interface for the Gemini platform, integrating with
 * Google GenAI client, system instruction cache, and candidate model fallback mechanisms.
 */
export class GeminiAiProvider implements FinancialAiProvider {
  public readonly providerName: string = 'gemini';

  private readonly googleGenAiClient: GoogleGenAI;
  private readonly candidateModelList: string[];
  private readonly systemInstructionCache: SystemInstructionCache;

  constructor(
    apiKey: string,
    primaryModelName: string = process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    fallbackModelList: string[] = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'],
    private readonly requestTimeoutMilliseconds: number = 20000,
    private readonly categoryContextService?: CategoryContextService
  ) {
    this.googleGenAiClient = new GoogleGenAI({ apiKey });
    this.candidateModelList = Array.from(new Set([primaryModelName, ...fallbackModelList]));
    this.systemInstructionCache = new SystemInstructionCache(categoryContextService);
  }

  public getSystemInstruction(
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[],
    referenceDate: Date = new Date()
  ): string {
    return this.systemInstructionCache.getSystemInstruction(
      availableAccountList,
      availableCategoryList,
      referenceDate
    );
  }

  public getSystemInstructionCacheKey(): string {
    return this.systemInstructionCache.getCacheKey();
  }

  private executeGeneration(options: {
    contents: any;
    systemInstruction: string;
    requestContextDescription?: string;
  }) {
    return executeGeminiGenerationWithFallback({
      googleGenAiClient: this.googleGenAiClient,
      candidateModelList: this.candidateModelList,
      requestTimeoutMilliseconds: this.requestTimeoutMilliseconds,
      contents: options.contents,
      systemInstruction: options.systemInstruction,
      requestContextDescription: options.requestContextDescription || 'Gemini financial processing',
    });
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
        providerLabel: 'Gemini',
      },
      (prepared) =>
        this.executeGeneration({
          contents: [
            {
              role: 'user',
              parts: [{ text: prepared.promptText }],
            },
          ],
          systemInstruction: prepared.systemInstruction,
          requestContextDescription: prepared.requestContextDescription,
        })
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
    return executeReceiptWorkflow(
      {
        imageBuffer,
        mimeType,
        optionalCaption,
        availableAccountList,
        availableCategoryList,
        referenceInstant,
        categoryContextService: this.categoryContextService,
        providerLabel: 'Gemini',
      },
      (prepared) =>
        this.executeGeneration({
          contents: [
            {
              role: 'user',
              parts: [
                { text: prepared.promptText },
                {
                  inlineData: {
                    data: imageBuffer.toString('base64'),
                    mimeType,
                  },
                },
              ],
            },
          ],
          systemInstruction: prepared.systemInstruction,
          requestContextDescription: prepared.requestContextDescription,
        })
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
        providerLabel: 'Gemini',
      },
      (prepared) =>
        this.executeGeneration({
          contents: [{ role: 'user', parts: [{ text: prepared.promptText }] }],
          systemInstruction: prepared.systemInstruction,
          requestContextDescription: prepared.requestContextDescription,
        })
    );
  }

  public async generateAccountClarificationQuestion(
    context: AccountClarificationQuestionContext
  ): Promise<{ question: string; tokenUsage?: TokenUsageStatistics }> {
    const { systemInstruction, promptText } = buildAccountClarificationQuestionPrompt(context);
    const result = await this.executeGeneration({
      contents: [{ role: 'user', parts: [{ text: promptText }] }],
      systemInstruction,
      requestContextDescription: `Account clarification question for draft #${context.ticketId}`,
    });

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
      context
    );
    const result = await this.executeGeneration({
      contents: [{ role: 'user', parts: [{ text: promptText }] }],
      systemInstruction,
      requestContextDescription: `Account clarification interpretation for draft #${context?.ticketId ?? 'unknown'}`,
    });

    return parseClarificationProposalResponse(result.responseText, result.tokenUsage);
  }
}
