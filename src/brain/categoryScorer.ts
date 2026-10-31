import { PendingCategorySelectionCandidate } from '../core/pending.js';
import { WalletCategoryItem } from '../wallet/index.js';

const SEMANTIC_SYNONYM_MAP: Record<string, string[]> = {
  obat: ['kesehatan', 'health', 'medis', 'medical', 'apotek', 'doctor'],
  medis: ['kesehatan', 'health', 'medical'],
  dokter: ['kesehatan', 'health', 'medical'],
  apotek: ['kesehatan', 'health', 'medical'],
  vitamin: ['kesehatan', 'health', 'medical'],
  makan: ['makanan', 'food', 'kuliner', 'restoran', 'restaurant', 'dining'],
  minum: ['minuman', 'beverage', 'drinks', 'coffee', 'kopi'],
  bensin: ['transport', 'transportasi', 'bensin', 'vehicle', 'kendaraan', 'fuel'],
  pulsa: ['komunikasi', 'communication', 'tagihan', 'bills', 'phone'],
  listrik: ['tagihan', 'bills', 'utilities', 'rumah'],
  gaji: ['income', 'pendapatan', 'salary'],
};

/**
 * Selects the best category matching a hint or transaction note based on token similarity and synonyms.
 */
export function selectBestCategory(
  categoryHint: string,
  candidateCategories: PendingCategorySelectionCandidate[],
  availableCategories: WalletCategoryItem[],
  recordNote?: string
): WalletCategoryItem | undefined {
  const assignableCategories = availableCategories.filter(
    category => category.isAssignable !== false
  );

  if (candidateCategories && candidateCategories.length === 1) {
    const matched = assignableCategories.find(
      category => category.id === candidateCategories[0].id
    );
    if (matched) {
      return matched;
    }
  }

  const combinedSearchText = [categoryHint, recordNote || ''].join(' ').toLowerCase().trim();
  if (!combinedSearchText) {
    return undefined;
  }

  const searchTokens = combinedSearchText
    .split(/[^\p{L}\p{N}]+/gu)
    .map(token => token.trim())
    .filter(token => token.length >= 2);

  const expandedTokens = new Set<string>(searchTokens);
  for (const token of searchTokens) {
    const synonyms = SEMANTIC_SYNONYM_MAP[token];
    if (synonyms) {
      for (const synonym of synonyms) {
        expandedTokens.add(synonym);
      }
    }
  }

  let highestScoredCategory: WalletCategoryItem | undefined;
  let highestScore = 0;

  for (const category of assignableCategories) {
    const categoryNameLower = category.name.toLowerCase();
    let currentScore = 0;

    for (const token of expandedTokens) {
      if (categoryNameLower === token) {
        currentScore += 10;
      } else if (categoryNameLower.includes(token)) {
        currentScore += 5;
      } else if (token.includes(categoryNameLower)) {
        currentScore += 3;
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
