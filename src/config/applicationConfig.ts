import {
  ApplicationEnvironmentConfiguration,
  DEFAULT_APP_CURRENCY,
  DEFAULT_APP_LANGUAGE,
  DEFAULT_APP_TIMEZONE,
  isValidIanaTimezone,
  loadEnvironmentConfiguration,
  resolveSafeTimezone,
} from './environmentConfig.js';

export {
  DEFAULT_APP_TIMEZONE,
  DEFAULT_APP_CURRENCY,
  DEFAULT_APP_LANGUAGE,
  isValidIanaTimezone,
  resolveSafeTimezone,
};

let activeRuntimeConfiguration: ApplicationEnvironmentConfiguration | null = null;

/**
 * Registers an active runtime application configuration (e.g. during application bootstrap or test isolation).
 */
export function setRuntimeApplicationConfig(
  configuration: ApplicationEnvironmentConfiguration | null
): void {
  activeRuntimeConfiguration = configuration;
}

/**
 * Resets any explicitly registered runtime configuration, restoring dynamic environment evaluation.
 */
export function resetRuntimeApplicationConfig(): void {
  activeRuntimeConfiguration = null;
}

/**
 * Obtains the active runtime application configuration, falling back to loading from environment variables.
 */
export function getRuntimeApplicationConfig(): ApplicationEnvironmentConfiguration {
  if (activeRuntimeConfiguration) {
    return activeRuntimeConfiguration;
  }
  return loadEnvironmentConfiguration();
}

/**
 * Resolves the canonical runtime application timezone safely.
 * Returns a valid IANA timezone identifier, falling back to 'Asia/Jakarta'.
 */
export function getApplicationTimezone(): string {
  if (activeRuntimeConfiguration) {
    return resolveSafeTimezone(activeRuntimeConfiguration.appTimezone);
  }
  const loadedConfiguration = loadEnvironmentConfiguration();
  return resolveSafeTimezone(loadedConfiguration.appTimezone);
}

/**
 * Resolves the canonical default currency.
 * Returns normalized uppercase currency code, falling back to 'IDR'.
 */
export function getDefaultCurrency(): string {
  if (activeRuntimeConfiguration) {
    const rawCurrency = (activeRuntimeConfiguration.defaultCurrency || '').toUpperCase().trim();
    return rawCurrency.length > 0 ? rawCurrency : DEFAULT_APP_CURRENCY;
  }
  const loadedConfiguration = loadEnvironmentConfiguration();
  return loadedConfiguration.defaultCurrency || DEFAULT_APP_CURRENCY;
}

/**
 * Resolves the canonical application language.
 * Returns supported language code ('id' | 'en'), falling back to 'id'.
 */
export function getApplicationLanguage(): 'id' | 'en' {
  if (activeRuntimeConfiguration) {
    const rawLanguage = (activeRuntimeConfiguration.appLanguage || '').toLowerCase().trim();
    return rawLanguage === 'en' ? 'en' : DEFAULT_APP_LANGUAGE;
  }
  const loadedConfiguration = loadEnvironmentConfiguration();
  return loadedConfiguration.appLanguage || DEFAULT_APP_LANGUAGE;
}
