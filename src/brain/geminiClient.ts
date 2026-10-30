import { GoogleGenAI } from '@google/genai';
import { applicationLogger, formatConciseErrorMessage } from '../utils/logger.js';
import { TokenUsageStatistics } from './types.js';
import { isRecoverableModelExecutionError } from './providerWorkflow.js';

export interface GenerationExecutionResult {
  responseText: string;
  tokenUsage?: TokenUsageStatistics;
}

export function sanitizeContentsForLogging(contents: any): any {
  if (!contents || !Array.isArray(contents)) return contents;
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
      return { ...contentItem, parts: sanitizedParts };
    }
    return contentItem;
  });
}

export async function executeGeminiGenerationWithFallback(options: {
  googleGenAiClient: GoogleGenAI;
  candidateModelList: string[];
  requestTimeoutMilliseconds: number;
  contents: any;
  systemInstruction: string;
  requestContextDescription: string;
}): Promise<GenerationExecutionResult> {
  const {
    googleGenAiClient,
    candidateModelList,
    requestTimeoutMilliseconds,
    contents,
    systemInstruction,
    requestContextDescription,
  } = options;

  let lastEncounteredError: unknown = null;

  for (let index = 0; index < candidateModelList.length; index++) {
    const activeModelName = candidateModelList[index];
    const isInitialAttempt = index === 0;

    try {
      if (!isInitialAttempt) {
        applicationLogger.info(
          `[Gemini Fallback] Falling back to candidate model: '${activeModelName}' for ${requestContextDescription}`
        );
      }

      applicationLogger.fileDetail('ai', `Executing Gemini request [${activeModelName}]`, {
        model: activeModelName,
        requestContextDescription,
        contents: sanitizeContentsForLogging(contents),
      });

      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        abortController.abort();
      }, requestTimeoutMilliseconds);

      let response: any;
      try {
        response = await googleGenAiClient.models.generateContent({
          model: activeModelName,
          contents,
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            abortSignal: abortController.signal,
          },
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      const rawResponseText = response?.text;
      if (!rawResponseText) {
        throw new Error(`Empty response returned from model '${activeModelName}'`);
      }

      let tokenUsage: TokenUsageStatistics | undefined;
      if (response.usageMetadata) {
        tokenUsage = {
          promptTokens: response.usageMetadata.promptTokenCount ?? 0,
          candidatesTokens: response.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: response.usageMetadata.totalTokenCount ?? 0,
          cachedContentTokens: response.usageMetadata.cachedContentTokenCount,
          thoughtsTokens: response.usageMetadata.thoughtsTokenCount,
        };
      }

      applicationLogger.fileDetail('ai', `Gemini response received [${activeModelName}]`, {
        responseText: rawResponseText,
        tokenUsage,
      });

      return { responseText: rawResponseText, tokenUsage };
    } catch (error: unknown) {
      lastEncounteredError = error;
      const conciseMessage = formatConciseErrorMessage(error);
      const hasNextCandidate = index < candidateModelList.length - 1;

      if (hasNextCandidate && isRecoverableModelExecutionError(error)) {
        applicationLogger.warn(
          `[Gemini Fallback] Model '${activeModelName}' failed for ${requestContextDescription}: ${conciseMessage}. Trying next model...`
        );
        continue;
      }

      applicationLogger.error(
        `[Gemini Error] Model execution failed permanently for ${requestContextDescription} on '${activeModelName}': ${conciseMessage}`
      );
      throw error;
    }
  }

  throw lastEncounteredError;
}
