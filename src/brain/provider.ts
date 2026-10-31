import {
  ApplicationEnvironmentConfiguration,
  SupportedAiProviderType,
  PROVIDER_CONFIG_STRATEGIES,
} from '../config/environmentConfig.js';
import { applicationLogger } from '../lib/logger.js';
import { FinancialAiProvider } from './types.js';
import { GeminiAiProvider } from './geminiProvider.js';
import { OpenAiCompatibleAiProvider } from './openAiProvider.js';
import { FallbackAiProvider } from './fallbackProvider.js';
import { CategoryContextService } from './categoryContext.js';

export * from './geminiProvider.js';
export * from './openAiProvider.js';
export * from './fallbackProvider.js';
export * from './providerWorkflow.js';

/**
 * Instantiates a single FinancialAiProvider based on provider type and environment configuration.
 */
export function createSingleFinancialAiProvider(
  providerType: SupportedAiProviderType,
  environmentConfig: ApplicationEnvironmentConfiguration,
  categoryContextService?: CategoryContextService
): FinancialAiProvider {
  if (providerType === 'gemini') {
    if (!environmentConfig.geminiApiKey) {
      applicationLogger.error('GEMINI_API_KEY is not defined in environment variables.');
    }

    return new GeminiAiProvider(
      environmentConfig.geminiApiKey,
      environmentConfig.geminiModel,
      environmentConfig.geminiFallbackModels,
      environmentConfig.geminiRequestTimeoutMilliseconds,
      categoryContextService
    );
  }

  const strategy = PROVIDER_CONFIG_STRATEGIES[providerType] || PROVIDER_CONFIG_STRATEGIES.custom;
  const baseUrl = environmentConfig.aiProvider === providerType
    ? environmentConfig.aiBaseUrl
    : (strategy.getDefaultBaseUrl() || environmentConfig.aiBaseUrl);
  const apiKey = environmentConfig.aiProvider === providerType
    ? environmentConfig.aiApiKey
    : (strategy.getDefaultApiKey(environmentConfig.geminiApiKey) || environmentConfig.aiApiKey);
  const primaryModelName = environmentConfig.aiProvider === providerType
    ? environmentConfig.aiModel
    : (strategy.getDefaultModel(environmentConfig.geminiModel) || environmentConfig.aiModel);

  if (!apiKey && providerType !== 'ollama') {
    applicationLogger.warn(
      `API key for AI provider '${providerType}' is not set (AI_API_KEY / ${providerType.toUpperCase()}_API_KEY). Requests may fail.`
    );
  }

  return new OpenAiCompatibleAiProvider({
    providerName: providerType,
    baseUrl,
    apiKey,
    primaryModelName,
    fallbackModelList: environmentConfig.aiFallbackModels,
    requestTimeoutMilliseconds: environmentConfig.aiRequestTimeoutMilliseconds,
    categoryContextService,
  });
}

/**
 * Factory that instantiates the active FinancialAiProvider based on environment configuration.
 * When multiple providers are specified in AI_PROVIDER (comma-separated), a priority-based
 * FallbackAiProvider is returned.
 */
export function createFinancialAiProvider(
  environmentConfig: ApplicationEnvironmentConfiguration,
  categoryContextService?: CategoryContextService
): FinancialAiProvider {
  const providerList = environmentConfig.aiProviders && environmentConfig.aiProviders.length > 0
    ? environmentConfig.aiProviders
    : [environmentConfig.aiProvider || 'gemini'];

  if (providerList.length === 1) {
    const singleProviderType = providerList[0];
    applicationLogger.info(`Initializing AI Provider: '${singleProviderType.toUpperCase()}'...`);
    return createSingleFinancialAiProvider(singleProviderType, environmentConfig, categoryContextService);
  }

  applicationLogger.info(
    `Initializing Multi-Provider AI Fallback Chain (${providerList.map(item => item.toUpperCase()).join(' -> ')})...`
  );

  const instantiatedProviders = providerList.map(type =>
    createSingleFinancialAiProvider(type, environmentConfig, categoryContextService)
  );

  return new FallbackAiProvider(instantiatedProviders);
}
