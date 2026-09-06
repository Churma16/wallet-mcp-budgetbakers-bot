import { ApplicationEnvironmentConfiguration } from '../../config/environmentConfig.js';
import { applicationLogger } from '../../utils/logger.js';
import { FinancialAiProvider } from './financialAiProvider.js';
import { GeminiAiProvider } from './geminiAiProvider.js';
import { OpenAiCompatibleAiProvider } from './openAiCompatibleAiProvider.js';

/**
 * Factory that instantiates the active FinancialAiProvider based on environment configuration
 */
export function createFinancialAiProvider(
  environmentConfig: ApplicationEnvironmentConfiguration
): FinancialAiProvider {
  const providerType = environmentConfig.aiProvider;

  applicationLogger.info(`Initializing AI Provider: '${providerType.toUpperCase()}'...`);

  if (providerType === 'gemini') {
    if (!environmentConfig.geminiApiKey) {
      applicationLogger.error('GEMINI_API_KEY is not defined in environment variables.');
    }

    return new GeminiAiProvider(
      environmentConfig.geminiApiKey,
      environmentConfig.geminiModel,
      environmentConfig.geminiFallbackModels,
      environmentConfig.geminiRequestTimeoutMilliseconds
    );
  }

  // OpenRouter, Groq, Ollama, OpenAI, or custom OpenAI-compatible provider
  if (!environmentConfig.aiApiKey && providerType !== 'ollama') {
    applicationLogger.warn(
      `API key for AI provider '${providerType}' is not set (AI_API_KEY / ${providerType.toUpperCase()}_API_KEY). Requests may fail.`
    );
  }

  return new OpenAiCompatibleAiProvider({
    providerName: providerType,
    baseUrl: environmentConfig.aiBaseUrl,
    apiKey: environmentConfig.aiApiKey,
    primaryModelName: environmentConfig.aiModel,
    fallbackModelList: environmentConfig.aiFallbackModels,
    requestTimeoutMilliseconds: environmentConfig.aiRequestTimeoutMilliseconds,
  });
}
