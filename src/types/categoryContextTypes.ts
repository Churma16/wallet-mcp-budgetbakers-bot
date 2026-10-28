/**
 * Types and interfaces for custom category semantics and user context definitions.
 */

export interface CategoryContextRule {
  /** Target category identifier or exact name (matched case-insensitively) */
  category: string;
  /** Primary semantic scope or description of the category */
  scope?: string;
  /** Representative examples of transactions belonging to this category */
  examples?: string[];
  /** Explicit exclusions: items or transactions that should NOT belong to this category */
  exclusions?: string[];
}

export interface UserLifestyleContext {
  /** General lifestyle or occupational profile */
  profile?: string;
  /** Specific behavioral habits or financial notes */
  notes?: string[];
}

export interface CategoryContextSettings {
  /** Mode for handling ambiguous/unresolved categories: 'ask' (prompt user) or 'auto' (AI best guess) */
  categoryResolutionMode?: 'ask' | 'auto';
}

export interface RawCategoryContextJson {
  /** Optional schema or configuration version indicator */
  version?: string | number;
  /** Behavioral or application configuration settings */
  settings?: CategoryContextSettings;
  /** High-level user profile or lifestyle hints */
  userContext?: string | UserLifestyleContext;
  /** Category semantic definitions represented as an array or dictionary map */
  categories?: CategoryContextRule[] | Record<string, Omit<CategoryContextRule, 'category'>>;
}

export interface NormalizedCategoryContextConfiguration {
  version: string;
  categoryResolutionMode: 'ask' | 'auto';
  userContextSummary: string;
  categoryRules: CategoryContextRule[];
}

export interface CategoryContextValidationIssue {
  readonly propertyPath: string;
  readonly message: string;
  readonly severity: 'warning' | 'error';
}

export interface CategoryContextValidationResult {
  readonly isValid: boolean;
  readonly configuration: NormalizedCategoryContextConfiguration;
  readonly issues: CategoryContextValidationIssue[];
}

export interface CategoryContextOverheadReport {
  readonly rawCharacterCount: number;
  readonly formattedCharacterCount: number;
  readonly estimatedTokenCount: number;
  readonly activeCategoryCount: number;
  readonly configuredCategoryCount: number;
}
