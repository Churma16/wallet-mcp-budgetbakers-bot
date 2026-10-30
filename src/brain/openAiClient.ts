import axios, { AxiosInstance } from 'axios';
import { CategoryContextService } from '../services/categoryContextService.js';
import { TokenUsageStatistics } from './types.js';
import { applicationLogger, formatConciseErrorMessage } from '../utils/logger.js';
import { isRecoverableModelExecutionError } from './providerWorkflow.js';

export interface OpenAiCompatibleProviderConfiguration {
  providerName?: string;
  baseUrl: string;
  apiKey: string;
  primaryModelName: string;
  fallbackModelList?: string[];
  requestTimeoutMilliseconds?: number;
  categoryContextService?: CategoryContextService;
}

export interface ChatCompletionResponsePayload {
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

export interface GenerationExecutionResult {
  responseText: string;
  tokenUsage?: TokenUsageStatistics;
}

export function trimTrailingSlashes(inputUrl: string): string {
  let endIndex = inputUrl.length;
  while (endIndex > 0 && inputUrl[endIndex - 1] === '/') {
    endIndex--;
  }
  return inputUrl.slice(0, endIndex);
}

export function createOpenAiHttpClient(
  baseUrl: string,
  apiKey: string,
  requestTimeoutMilliseconds: number
): AxiosInstance {
  const authorizationHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://github.com/wallet_mcp',
    'X-Title': 'Wallet MCP Bookkeeper',
  };

  if (apiKey && apiKey.trim().length > 0) {
    authorizationHeaders.Authorization = `Bearer ${apiKey.trim()}`;
  }

  return axios.create({
    baseURL: trimTrailingSlashes(baseUrl),
    headers: authorizationHeaders,
    timeout: requestTimeoutMilliseconds,
  });
}

export async function executeChatCompletionWithFallback(
  httpClient: AxiosInstance,
  candidateModelList: string[],
  providerName: string,
  requestTimeoutMilliseconds: number,
  messages: Array<Record<string, unknown>>,
  requestContextDescription?: string,
  enforceJsonResponseFormat: boolean = true
): Promise<GenerationExecutionResult> {
  let lastEncounteredError: unknown = null;

  for (let modelIndex = 0; modelIndex < candidateModelList.length; modelIndex++) {
    const currentCandidateModel = candidateModelList[modelIndex];
    const startExecutionTimestamp = Date.now();

    applicationLogger.fileDetail('ai', `Dispatched ${providerName} Request [${currentCandidateModel}]`, {
      provider: providerName,
      model: currentCandidateModel,
      context: requestContextDescription || 'General message processing',
      messagesSummary: `Total messages: ${messages.length}`,
    });

    const heartbeatTimer = setInterval(() => {
      const elapsedExecutionSeconds = Math.round((Date.now() - startExecutionTimestamp) / 1000);
      applicationLogger.ai(
        `Waiting for ${providerName} [${currentCandidateModel}] response... (${elapsedExecutionSeconds}s elapsed)`
      );
    }, 5000);

    const abortController = new AbortController();
    const timeoutTimer = setTimeout(() => {
      abortController.abort();
    }, requestTimeoutMilliseconds);

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
        response = await httpClient.post<ChatCompletionResponsePayload>(
          '/chat/completions',
          requestPayload,
          { signal: abortController.signal }
        );
      } catch (postError: any) {
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
          return await executeChatCompletionWithFallback(
            httpClient,
            candidateModelList,
            providerName,
            requestTimeoutMilliseconds,
            messages,
            requestContextDescription,
            false
          );
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
        `${providerName} [${currentCandidateModel}] responded in ${executionDurationMilliseconds}ms | Tokens: ${totalTokens} (Prompt: ${promptTokens}, Output: ${candidatesTokens})`
      );

      const tokenUsage: TokenUsageStatistics = { promptTokens, candidatesTokens, totalTokens };

      applicationLogger.fileDetail('ai', `Received ${providerName} Response [${currentCandidateModel}] (${executionDurationMilliseconds}ms)`, {
        model: currentCandidateModel,
        latencyMilliseconds: executionDurationMilliseconds,
        tokenUsage,
        rawResponse: rawContent,
      });

      return { responseText: rawContent, tokenUsage };
    } catch (error: any) {
      lastEncounteredError = error;
      const executionDurationMilliseconds = Date.now() - startExecutionTimestamp;
      const errorMessage = error?.response?.data?.error?.message || error?.message || String(error);
      const isRecoverableModelError = isRecoverableModelExecutionError(error);
      const hasNextFallbackModel = modelIndex + 1 < candidateModelList.length;

      applicationLogger.fileDetail('error', `${providerName} Model Execution Failed [${currentCandidateModel}] (${executionDurationMilliseconds}ms)`, {
        model: currentCandidateModel,
        duration: `${executionDurationMilliseconds}ms`,
        errorMessage,
        isRecoverable: isRecoverableModelError,
        hasNextFallback: hasNextFallbackModel,
      });

      if (isRecoverableModelError && hasNextFallbackModel) {
        const nextCandidateModel = candidateModelList[modelIndex + 1];
        const conciseErrorSummary = formatConciseErrorMessage(errorMessage);
        applicationLogger.warn(
          `Model '${currentCandidateModel}' failed (${conciseErrorSummary}). Retrying with fallback model '${nextCandidateModel}'...`
        );
        continue;
      }

      throw new Error(`${providerName} error (${currentCandidateModel}): ${errorMessage}`);
    } finally {
      clearInterval(heartbeatTimer);
      clearTimeout(timeoutTimer);
    }
  }

  throw lastEncounteredError || new Error(`All candidate models failed for provider ${providerName}`);
}
