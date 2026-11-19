import { GoogleGenAI } from '@google/genai';
import { applicationLogger, formatConciseErrorMessage } from '../../lib/logger.js';
import { ModelFallbackProgressCallback, TokenUsageStatistics } from '../types.js';
import { isRecoverableModelExecutionError } from './providerWorkflow.js';
import { PrometheusMetricsRegistry } from '../../observability/index.js';

export interface GenerationExecutionResult {
  responseText: string;
  tokenUsage?: TokenUsageStatistics;
}

export interface GeminiFallbackExecutionOptions {
  googleGenAiClient: GoogleGenAI;
  candidateModelList: string[];
  requestTimeoutMilliseconds: number;
  contents: any;
  systemInstruction: string;
  requestContextDescription: string;
  onFallbackAttempt?: ModelFallbackProgressCallback;
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

export async function executeGeminiGenerationWithFallback(
  options: GeminiFallbackExecutionOptions
): Promise<GenerationExecutionResult> {
  const {
    googleGenAiClient,
    candidateModelList,
    requestTimeoutMilliseconds,
    contents,
    systemInstruction,
    requestContextDescription,
    onFallbackAttempt,
  } = options;

  let lastEncounteredError: unknown = null;

  for (let index = 0; index < candidateModelList.length; index++) {
    const activeModelName = candidateModelList[index];
    const isInitialAttempt = index === 0;
    const requestStartMs = Date.now();

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

      const durationSeconds = (Date.now() - requestStartMs) / 1000;
      const metrics = PrometheusMetricsRegistry.getInstance();
      metrics.recordRequest('gemini', 'success');
      metrics.recordDuration('gemini', durationSeconds);
      if (tokenUsage) {
        if (tokenUsage.promptTokens > 0) metrics.recordTokens('gemini', 'input', tokenUsage.promptTokens);
        if (tokenUsage.candidatesTokens > 0) metrics.recordTokens('gemini', 'output', tokenUsage.candidatesTokens);
        if (tokenUsage.thoughtsTokens && tokenUsage.thoughtsTokens > 0) metrics.recordTokens('gemini', 'thinking', tokenUsage.thoughtsTokens);
        if (tokenUsage.cachedContentTokens && tokenUsage.cachedContentTokens > 0) {
          metrics.recordTokens('gemini', 'cached', tokenUsage.cachedContentTokens);
          metrics.recordCacheEvent('gemini', 'hit');
        } else {
          metrics.recordCacheEvent('gemini', 'miss');
        }
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
        const nextModelName = candidateModelList[index + 1];
        const metrics = PrometheusMetricsRegistry.getInstance();
        metrics.recordRequest('gemini', 'fallback');
        metrics.recordFallback(activeModelName, nextModelName);
        applicationLogger.warn(
          `[Gemini Fallback] Model '${activeModelName}' failed for ${requestContextDescription}: ${conciseMessage}. Trying next model '${nextModelName}'...`
        );

        if (onFallbackAttempt) {
          try {
            await onFallbackAttempt({
              currentModel: activeModelName,
              nextModel: nextModelName,
              attemptIndex: index + 1,
              totalCandidates: candidateModelList.length,
              reason: conciseMessage,
            });
          } catch (callbackError: unknown) {
            applicationLogger.warn(
              `[Gemini Fallback] onFallbackAttempt callback failed for ${requestContextDescription}: ${callbackError}`
            );
          }
        }
        continue;
      }

      PrometheusMetricsRegistry.getInstance().recordRequest('gemini', 'error');
      applicationLogger.error(
        `[Gemini Error] Model execution failed permanently for ${requestContextDescription} on '${activeModelName}': ${conciseMessage}`
      );
      throw error;
    }
  }

  throw lastEncounteredError;
}
