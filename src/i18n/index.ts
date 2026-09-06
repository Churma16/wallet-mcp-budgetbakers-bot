import { SupportedLanguage, ResponseDictionary } from './types.js';
import { indonesianDictionary } from './locales/id.js';
import { englishDictionary } from './locales/en.js';

export * from './types.js';
export { indonesianDictionary } from './locales/id.js';
export { englishDictionary } from './locales/en.js';

const DICTIONARY_REGISTRY: Record<SupportedLanguage, ResponseDictionary> = {
  id: indonesianDictionary,
  en: englishDictionary,
};

let activeApplicationLanguage: SupportedLanguage = 'id';

/**
 * Updates the globally active application language
 */
export function setActiveLanguage(languageCode: SupportedLanguage): void {
  if (languageCode in DICTIONARY_REGISTRY) {
    activeApplicationLanguage = languageCode;
  }
}

/**
 * Retrieves the currently active application language code
 */
export function getActiveLanguage(): SupportedLanguage {
  return activeApplicationLanguage;
}

/**
 * Retrieves the response dictionary for a specific language or the currently active language
 */
export function getDictionary(languageCode?: SupportedLanguage): ResponseDictionary {
  const selectedLanguage = languageCode || activeApplicationLanguage;
  return DICTIONARY_REGISTRY[selectedLanguage] || indonesianDictionary;
}
