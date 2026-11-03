import { PendingCategorySelectionCandidate } from '../../core/pending.js';
import { WalletCategoryItem } from '../../wallet/index.js';
import { isAutoCategoryToken } from '../../wallet/records/recordEditParser.js';
import { CategoryContextRule } from './categoryContextTypes.js';
import { resolveSemanticCategoryHint } from '../semantic/semanticEntityResolver.js';
import { FinancialAiProvider } from '../types.js';
import { applicationLogger, formatConciseErrorMessage } from '../../lib/logger.js';

/**
 * Selects the best category matching a hint or transaction note based on direct token similarity.
 * Serves as a deterministic local fallback when AI classification is not available or unconfigured.
 */
export function selectBestCategory(
  categoryHint: string,
  candidateCategories: PendingCategorySelectionCandidate[],
  availableCategories: WalletCategoryItem[],
  recordNote?: string
): WalletCategoryItem | undefined {
  const assignableCategories = availableCategories.filter(
    category =>
      category.isAssignable !== false &&
      category.group?.id !== 'system_categories'
  );

  if (candidateCategories && candidateCategories.length === 1) {
    const matched = assignableCategories.find(
      category => category.id === candidateCategories[0].id
    );
    if (matched) {
      return matched;
    }
  }

  const effectiveHint = isAutoCategoryToken(categoryHint) ? '' : categoryHint;
  const combinedSearchText = [effectiveHint, recordNote || ''].join(' ').toLowerCase().trim();
  if (!combinedSearchText) {
    return undefined;
  }

  const searchTokens = combinedSearchText
    .split(/[^\p{L}\p{N}]+/gu)
    .map(token => token.trim())
    .filter(token => token.length >= 2);

  let highestScoredCategory: WalletCategoryItem | undefined;
  let highestScore = 0;

  for (const category of assignableCategories) {
    const categoryNameLower = category.name.toLowerCase();
    const groupNameLower = category.group?.name?.toLowerCase();
    let currentScore = 0;

    for (const token of searchTokens) {
      if (categoryNameLower === token) {
        currentScore += 10;
      } else if (token.length >= 3 && categoryNameLower.includes(token)) {
        currentScore += 5;
      } else if (categoryNameLower.length >= 3 && token.includes(categoryNameLower)) {
        currentScore += 3;
      }

      if (groupNameLower) {
        if (groupNameLower === token) {
          currentScore += 8;
        } else if (token.length >= 3 && groupNameLower.includes(token)) {
          currentScore += 4;
        }
      }
    }

    if (currentScore > highestScore) {
      highestScore = currentScore;
      highestScoredCategory = category;
    }
  }

  if (highestScore >= 3 && highestScoredCategory) {
    return highestScoredCategory;
  }

  if (candidateCategories && candidateCategories.length > 0) {
    const fallbackMatched = assignableCategories.find(
      category => category.id === candidateCategories[0].id
    );
    if (fallbackMatched) {
      return fallbackMatched;
    }
  }

  return undefined;
}

/**
 * Automatically infers and resolves the best matching Wallet category from transaction note
 * or descriptive text.
 *
 * Execution Hierarchy:
 * 1. AI Provider (LLM reasoning over categories without restrictive static synonyms)
 * 2. Explicit custom Category Rules (if configured)
 * 3. Deterministic token matching fallback (when AI is unavailable/offline)
 */
export async function inferCategoryFromText(
  text: string | undefined,
  availableCategories: WalletCategoryItem[],
  aiProvider?: FinancialAiProvider,
  categoryRules?: CategoryContextRule[]
): Promise<WalletCategoryItem | undefined> {
  if (!text || !text.trim() || !availableCategories || availableCategories.length === 0) {
    return undefined;
  }

  const cleanText = text.trim();
  const assignableCategories = availableCategories.filter(
    category =>
      category.isAssignable !== false &&
      category.group?.id !== 'system_categories'
  );

  // 1. Primary: Use AI Provider for broad, contextual semantic categorization
  if (aiProvider && typeof aiProvider.classifyCategory === 'function') {
    try {
      const proposal = await aiProvider.classifyCategory(cleanText, assignableCategories);
      if (proposal?.categoryId) {
        const matched = assignableCategories.find(c => c.id === proposal.categoryId);
        if (matched) {
          applicationLogger.info(
            `[AI Category] Classified "${cleanText.slice(0, 40)}" to "${matched.name}" (${matched.id}) via ${aiProvider.providerName}`
          );
          return matched;
        }
      }
    } catch (aiError) {
      applicationLogger.warn(
        `[AI Category] AI classification failed for "${cleanText.slice(0, 40)}": ${formatConciseErrorMessage(aiError)}. Falling back to deterministic resolver.`
      );
    }
  }

  // 2. Secondary: Explicit custom Category Rules if configured
  if (categoryRules && categoryRules.length > 0) {
    const semanticResult = resolveSemanticCategoryHint(
      cleanText,
      assignableCategories,
      categoryRules
    );
    if (semanticResult.status === 'RESOLVED') {
      const match = assignableCategories.find(c => c.id === semanticResult.id);
      if (match) {
        return match;
      }
    }
  }

  // 3. Fallback: Local token matching when AI is unavailable/offline
  return selectBestCategory('', [], assignableCategories, cleanText);
}
