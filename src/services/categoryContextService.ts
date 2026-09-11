import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WalletCategoryItem } from '../types/walletTypes.js';
import {
  CategoryContextRule,
  UserLifestyleContext,
  RawCategoryContextJson,
  NormalizedCategoryContextConfiguration,
  CategoryContextValidationResult,
  CategoryContextValidationIssue,
  CategoryContextOverheadReport,
} from '../types/categoryContextTypes.js';
import { applicationLogger } from '../utils/logger.js';

export class CategoryContextService {
  private readonly targetFilePath: string;
  private normalizedConfiguration: NormalizedCategoryContextConfiguration;
  private cachedContextFingerprint: string = '';
  private rawFileContent: string = '';

  constructor(customFilePath?: string) {
    this.targetFilePath = customFilePath || process.env.CATEGORY_CONTEXT_PATH || 'config/category-context.json';
    this.normalizedConfiguration = this.createEmptyConfiguration();
    this.loadConfiguration();
  }

  private createEmptyConfiguration(): NormalizedCategoryContextConfiguration {
    return {
      version: '1.0',
      userContextSummary: '',
      categoryRules: [],
    };
  }

  /**
   * Resolves absolute file path for the category context configuration
   */
  public getResolvedFilePath(): string {
    if (path.isAbsolute(this.targetFilePath)) {
      return this.targetFilePath;
    }
    return path.resolve(process.cwd(), this.targetFilePath);
  }

  /**
   * Loads and validates the configuration file from disk.
   * If the file is missing or invalid, falls back safely to empty configuration without crashing.
   */
  public loadConfiguration(): CategoryContextValidationResult {
    const resolvedPath = this.getResolvedFilePath();

    if (!fs.existsSync(resolvedPath)) {
      this.rawFileContent = '';
      this.normalizedConfiguration = this.createEmptyConfiguration();
      this.cachedContextFingerprint = '';
      applicationLogger.info(`[INFO] No category context file found at '${resolvedPath}'. Using default category semantics.`);
      return {
        isValid: true,
        configuration: this.normalizedConfiguration,
        issues: [],
      };
    }

    try {
      this.rawFileContent = fs.readFileSync(resolvedPath, 'utf8');
    } catch (readError: unknown) {
      const errorMessage = readError instanceof Error ? readError.message : String(readError);
      applicationLogger.warn(`[WARN] Failed to read category context file at '${resolvedPath}': ${errorMessage}. Falling back safely.`);
      this.normalizedConfiguration = this.createEmptyConfiguration();
      this.cachedContextFingerprint = '';
      return {
        isValid: false,
        configuration: this.normalizedConfiguration,
        issues: [{ propertyPath: 'file', message: `Read error: ${errorMessage}`, severity: 'error' }],
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(this.rawFileContent);
    } catch (syntaxError: unknown) {
      const errorMessage = syntaxError instanceof Error ? syntaxError.message : String(syntaxError);
      applicationLogger.warn(
        `[WARN] Category context file at '${resolvedPath}' contains invalid JSON syntax: ${errorMessage}. Falling back safely to default categories.`
      );
      this.normalizedConfiguration = this.createEmptyConfiguration();
      this.cachedContextFingerprint = '';
      return {
        isValid: false,
        configuration: this.normalizedConfiguration,
        issues: [{ propertyPath: 'syntax', message: `JSON syntax error: ${errorMessage}`, severity: 'error' }],
      };
    }

    const validationResult = this.validateAndNormalizeConfiguration(parsedJson);
    this.normalizedConfiguration = validationResult.configuration;
    this.cachedContextFingerprint = this.computeContextFingerprint(this.normalizedConfiguration);

    if (validationResult.issues.length > 0) {
      for (const issue of validationResult.issues) {
        if (issue.severity === 'warning') {
          applicationLogger.warn(`[WARN] Category context issue at '${issue.propertyPath}': ${issue.message}`);
        } else {
          applicationLogger.error(`[ERROR] Category context issue at '${issue.propertyPath}': ${issue.message}`);
        }
      }
    }

    applicationLogger.info(
      `[INFO] Loaded category context with ${this.normalizedConfiguration.categoryRules.length} valid rule(s) and fingerprint '${this.cachedContextFingerprint || 'NONE'}'.`
    );

    return validationResult;
  }

  /**
   * Reloads configuration from disk to refresh active context
   */
  public reload(): CategoryContextValidationResult {
    return this.loadConfiguration();
  }

  /**
   * Returns current normalized configuration
   */
  public getConfiguration(): NormalizedCategoryContextConfiguration {
    return this.normalizedConfiguration;
  }

  /**
   * Computes a stable deterministic SHA-256 fingerprint representing the current active context.
   * This fingerprint is incorporated into AI system instruction cache keys.
   */
  public getContextFingerprint(): string {
    return this.cachedContextFingerprint;
  }

  /**
   * Normalizes and validates raw JSON payload into structured CategoryContextConfiguration.
   * Tolerates missing or partially invalid fields by filtering out invalid entries.
   */
  public validateAndNormalizeConfiguration(rawInput: unknown): CategoryContextValidationResult {
    const issues: CategoryContextValidationIssue[] = [];

    if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
      issues.push({
        propertyPath: 'root',
        message: 'Root configuration must be a JSON object.',
        severity: 'error',
      });
      return {
        isValid: false,
        configuration: this.createEmptyConfiguration(),
        issues,
      };
    }

    const typedInput = rawInput as RawCategoryContextJson;

    // 1. Version
    const versionString = typedInput.version !== undefined ? String(typedInput.version).trim() : '1.0';

    // 2. User Lifestyle Context
    let userContextSummary = '';
    if (typeof typedInput.userContext === 'string') {
      userContextSummary = typedInput.userContext.trim();
    } else if (typeof typedInput.userContext === 'object' && typedInput.userContext !== null) {
      const userObj = typedInput.userContext as UserLifestyleContext;
      const profilePart = typeof userObj.profile === 'string' ? userObj.profile.trim() : '';
      const notesParts = Array.isArray(userObj.notes)
        ? userObj.notes.filter((noteItem): noteItem is string => typeof noteItem === 'string' && noteItem.trim().length > 0)
        : [];

      const combinedSegments: string[] = [];
      if (profilePart) {
        combinedSegments.push(profilePart);
      }
      if (notesParts.length > 0) {
        combinedSegments.push(notesParts.map(item => `- ${item.trim()}`).join('\n'));
      }
      userContextSummary = combinedSegments.join('\n');
    } else if (typedInput.userContext !== undefined) {
      issues.push({
        propertyPath: 'userContext',
        message: 'Property userContext must be either a string or an object with profile/notes.',
        severity: 'warning',
      });
    }

    // 3. Category Rules (Supports array of rules or dictionary map)
    const validCategoryRules: CategoryContextRule[] = [];

    if (Array.isArray(typedInput.categories)) {
      typedInput.categories.forEach((ruleItem, index) => {
        const validatedRule = this.validateSingleCategoryRule(ruleItem, `categories[${index}]`, issues);
        if (validatedRule) {
          validCategoryRules.push(validatedRule);
        }
      });
    } else if (typeof typedInput.categories === 'object' && typedInput.categories !== null) {
      // Dictionary format: { "Category Name": { scope, examples, exclusions } }
      for (const [categoryName, ruleDetails] of Object.entries(typedInput.categories)) {
        if (typeof ruleDetails === 'object' && ruleDetails !== null) {
          const synthesizedRule: CategoryContextRule = {
            category: categoryName,
            ...(ruleDetails as any),
          };
          const validatedRule = this.validateSingleCategoryRule(synthesizedRule, `categories["${categoryName}"]`, issues);
          if (validatedRule) {
            validCategoryRules.push(validatedRule);
          }
        } else {
          issues.push({
            propertyPath: `categories["${categoryName}"]`,
            message: 'Category rule definition must be an object.',
            severity: 'warning',
          });
        }
      }
    } else if (typedInput.categories !== undefined) {
      issues.push({
        propertyPath: 'categories',
        message: 'Property categories must be an array or an object map.',
        severity: 'warning',
      });
    }

    // Deterministically deduplicate rules by lowercase category name (first valid definition takes precedence)
    const uniqueRules: CategoryContextRule[] = [];
    const seenCategoryNames = new Set<string>();

    for (const rule of validCategoryRules) {
      const lowerName = rule.category.toLowerCase();
      if (!seenCategoryNames.has(lowerName)) {
        seenCategoryNames.add(lowerName);
        uniqueRules.push(rule);
      } else {
        issues.push({
          propertyPath: `categories.${rule.category}`,
          message: `Duplicate category rule for '${rule.category}'. Subsequent definition ignored.`,
          severity: 'warning',
        });
      }
    }

    return {
      isValid: issues.filter(i => i.severity === 'error').length === 0,
      configuration: {
        version: versionString,
        userContextSummary,
        categoryRules: uniqueRules,
      },
      issues,
    };
  }

  /**
   * Validates a single category context rule definition
   */
  private validateSingleCategoryRule(
    rawRule: unknown,
    propertyPath: string,
    issues: CategoryContextValidationIssue[]
  ): CategoryContextRule | null {
    if (typeof rawRule !== 'object' || rawRule === null) {
      issues.push({
        propertyPath,
        message: 'Rule item must be a JSON object.',
        severity: 'warning',
      });
      return null;
    }

    const ruleObj = rawRule as Partial<CategoryContextRule>;

    if (typeof ruleObj.category !== 'string' || ruleObj.category.trim().length === 0) {
      issues.push({
        propertyPath: `${propertyPath}.category`,
        message: 'Rule must define a non-empty string for category name or ID.',
        severity: 'warning',
      });
      return null;
    }

    const cleanCategory = ruleObj.category.trim();
    const cleanScope = typeof ruleObj.scope === 'string' ? ruleObj.scope.trim() : undefined;

    let cleanExamples: string[] | undefined;
    if (Array.isArray(ruleObj.examples)) {
      cleanExamples = ruleObj.examples
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map(item => item.trim());
      if (cleanExamples.length === 0) {
        cleanExamples = undefined;
      }
    } else if (ruleObj.examples !== undefined) {
      issues.push({
        propertyPath: `${propertyPath}.examples`,
        message: 'examples property must be an array of strings.',
        severity: 'warning',
      });
    }

    let cleanExclusions: string[] | undefined;
    if (Array.isArray(ruleObj.exclusions)) {
      cleanExclusions = ruleObj.exclusions
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map(item => item.trim());
      if (cleanExclusions.length === 0) {
        cleanExclusions = undefined;
      }
    } else if (ruleObj.exclusions !== undefined) {
      issues.push({
        propertyPath: `${propertyPath}.exclusions`,
        message: 'exclusions property must be an array of strings.',
        severity: 'warning',
      });
    }

    return {
      category: cleanCategory,
      scope: cleanScope,
      examples: cleanExamples,
      exclusions: cleanExclusions,
    };
  }

  /**
   * Computes a deterministic SHA-256 fingerprint of the normalized configuration
   */
  private computeContextFingerprint(configuration: NormalizedCategoryContextConfiguration): string {
    if (!configuration.userContextSummary && configuration.categoryRules.length === 0) {
      return '';
    }

    // Sort rules alphabetically by category name for deterministic hashing
    const sortedRules = [...configuration.categoryRules].sort((a, b) =>
      a.category.toLowerCase().localeCompare(b.category.toLowerCase())
    );

    const canonicalRepresentation = JSON.stringify({
      version: configuration.version,
      userContext: configuration.userContextSummary,
      rules: sortedRules.map(rule => ({
        category: rule.category.toLowerCase(),
        scope: rule.scope || '',
        examples: rule.examples || [],
        exclusions: rule.exclusions || [],
      })),
    });

    return crypto.createHash('sha256').update(canonicalRepresentation, 'utf8').digest('hex').substring(0, 16);
  }

  /**
   * Generates a compact, deterministic prompt section formatted for AI system instructions.
   * If availableCategoryList is provided, only rules corresponding to active categories are included.
   */
  public formatCompactContext(availableCategoryList?: WalletCategoryItem[]): string {
    const rules = this.normalizedConfiguration.categoryRules;
    const userContext = this.normalizedConfiguration.userContextSummary;

    // Filter rules if available categories are provided
    let activeRules = rules;
    if (availableCategoryList && availableCategoryList.length > 0) {
      const activeCategoryNames = new Set(
        availableCategoryList.map(cat => cat.name.toLowerCase().trim())
      );
      const activeCategoryIds = new Set(
        availableCategoryList.map(cat => cat.id.toLowerCase().trim())
      );

      activeRules = rules.filter(rule => {
        const targetCategory = rule.category.toLowerCase().trim();
        return activeCategoryNames.has(targetCategory) || activeCategoryIds.has(targetCategory);
      });
    }

    if (activeRules.length === 0 && !userContext) {
      return '';
    }

    // Sort active rules deterministically by category name
    const sortedRules = [...activeRules].sort((a, b) =>
      a.category.toLowerCase().localeCompare(b.category.toLowerCase())
    );

    const promptSegments: string[] = [];

    if (sortedRules.length > 0) {
      const formattedRuleLines = sortedRules.map(rule => {
        const lineParts: string[] = [];
        if (rule.scope) {
          lineParts.push(rule.scope);
        }
        if (rule.examples && rule.examples.length > 0) {
          lineParts.push(`Ex: ${rule.examples.join(', ')}`);
        }
        if (rule.exclusions && rule.exclusions.length > 0) {
          lineParts.push(`Exclude: ${rule.exclusions.join(', ')}`);
        }

        const detailsText = lineParts.length > 0 ? lineParts.join(' | ') : 'Custom semantic scope';
        return `- "${rule.category}": ${detailsText}`;
      });

      promptSegments.push(`CATEGORY SEMANTICS & RULES:\n${formattedRuleLines.join('\n')}`);
    }

    if (userContext) {
      promptSegments.push(`USER CONTEXT:\n${userContext}`);
    }

    return promptSegments.join('\n\n');
  }

  /**
   * Measures and reports token/character prompt overhead of the custom context
   */
  public measureOverhead(availableCategoryList?: WalletCategoryItem[]): CategoryContextOverheadReport {
    const formattedText = this.formatCompactContext(availableCategoryList);
    const formattedCharacterCount = formattedText.length;
    // Standard rule of thumb: ~4 characters per token in English/Indonesian
    const estimatedTokenCount = Math.ceil(formattedCharacterCount / 4);

    let activeCategoryCount = this.normalizedConfiguration.categoryRules.length;
    if (availableCategoryList && availableCategoryList.length > 0) {
      const activeCategoryNames = new Set(
        availableCategoryList.map(cat => cat.name.toLowerCase().trim())
      );
      const activeCategoryIds = new Set(
        availableCategoryList.map(cat => cat.id.toLowerCase().trim())
      );
      activeCategoryCount = this.normalizedConfiguration.categoryRules.filter(rule => {
        const targetCategory = rule.category.toLowerCase().trim();
        return activeCategoryNames.has(targetCategory) || activeCategoryIds.has(targetCategory);
      }).length;
    }

    return {
      rawCharacterCount: this.rawFileContent.length,
      formattedCharacterCount,
      estimatedTokenCount,
      activeCategoryCount,
      configuredCategoryCount: this.normalizedConfiguration.categoryRules.length,
    };
  }
}
