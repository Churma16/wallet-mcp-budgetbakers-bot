import { PendingCategorySelectionCandidate } from '../../core/pending.js';
import { WalletCategoryItem } from '../../wallet/index.js';
import { isAutoCategoryToken } from '../../wallet/records/recordEditParser.js';
import { CategoryContextRule } from './categoryContextTypes.js';
import { resolveSemanticCategoryHint } from '../semantic/semanticEntityResolver.js';

const STOP_WORDS = new Set([
  'di', 'ke', 'dari', 'pada', 'untuk', 'dan', 'yang', 'ini', 'itu', 'buat',
  'to', 'in', 'at', 'on', 'for', 'and', 'of', 'the', 'is', 'a', 'an', 'by', 'with',
]);

const SYNONYM_CLUSTERS: readonly (readonly string[])[] = [
  // Health & Medicine
  [
    'obat', 'kesehatan', 'health', 'medis', 'medical', 'apotek', 'doctor', 'dokter',
    'vitamin', 'klinik', 'clinic', 'hospital', 'halodoc', 'alodokter', 'farmasi', 'pharmacy',
  ],
  // Food & Dining
  [
    'makan', 'makanan', 'food', 'kuliner', 'restoran', 'restaurant', 'dining', 'lunch',
    'dinner', 'sarapan', 'warteg', 'padang', 'resto', 'cafe', 'kafe', 'nasi', 'mie',
    'bakso', 'ayam', 'soto', 'burger', 'pizza', 'mcd', 'kfc', 'hokben', 'gofood',
    'grabfood', 'shopeefood',
  ],
  // Drinks & Coffee
  [
    'minum', 'minuman', 'beverage', 'drinks', 'coffee', 'kopi', 'tea', 'teh', 'boba',
    'starbucks', 'kenangan', 'fore', 'janji', 'jiwa',
  ],
  // Transportation & Fuel
  [
    'bensin', 'pertamax', 'pertalite', 'solar', 'shell', 'spbu', 'bbm', 'fuel',
    'transport', 'transportasi', 'vehicle', 'kendaraan', 'parkir', 'parking', 'tol',
    'toll', 'grab', 'grabcar', 'gojek', 'goride', 'gocar', 'ojol', 'taksi', 'taxi',
    'mrt', 'lrt', 'krl', 'kereta', 'busway', 'transjakarta', 'angkot', 'stasiun',
    'bandara', 'airport',
  ],
  // Groceries & Shopping
  [
    'belanja', 'shopping', 'supermarket', 'minimarket', 'groceries', 'sembako', 'pasar',
    'indomaret', 'alfamart', 'alfamidi', 'superindo', 'hypermart', 'transmart', 'tokopedia',
    'shopee', 'lazada', 'blibli',
  ],
  // Bills & Utilities
  [
    'tagihan', 'bills', 'utilities', 'listrik', 'pln', 'air', 'pdam', 'internet', 'wifi',
    'indihome', 'biznet', 'pulsa', 'paket data', 'telkomsel', 'indosat', 'xl', 'tri',
    'smartfren', 'bpjs', 'pajak', 'tax',
  ],
  // Entertainment & Leisure
  [
    'hiburan', 'entertainment', 'life_entertainment', 'nonton', 'bioskop', 'cinema',
    'xxi', 'cgv', 'netflix', 'spotify', 'youtube', 'disney', 'game', 'games', 'steam',
    'playstation', 'liburan', 'hotel',
  ],
  // Income & Salary
  [
    'gaji', 'salary', 'income', 'pendapatan', 'bonus', 'thr', 'dividen', 'dividend',
    'cashback', 'reimburse', 'reimbursement',
  ],
  // Housing & Rent
  [
    'rumah', 'housing', 'kost', 'kos', 'kontrakan', 'sewa', 'rent', 'apartemen', 'apartment',
  ],
  // Education
  [
    'pendidikan', 'education', 'kursus', 'course', 'buku', 'book', 'kuliah', 'sekolah',
    'tuition', 'spp',
  ],
];

const SEMANTIC_SYNONYM_MAP: Record<string, string[]> = {};
for (const cluster of SYNONYM_CLUSTERS) {
  for (const word of cluster) {
    if (!SEMANTIC_SYNONYM_MAP[word]) {
      SEMANTIC_SYNONYM_MAP[word] = [];
    }
    for (const other of cluster) {
      if (other !== word && !SEMANTIC_SYNONYM_MAP[word].includes(other)) {
        SEMANTIC_SYNONYM_MAP[word].push(other);
      }
    }
  }
}

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
    .filter(token => token.length >= 2 && !STOP_WORDS.has(token));

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
    const groupNameLower = category.group?.name?.toLowerCase();
    let currentScore = 0;

    for (const token of expandedTokens) {
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
 * or descriptive text using semantic rules and keyword scoring.
 */
export function inferCategoryFromText(
  text: string | undefined,
  availableCategories: WalletCategoryItem[],
  categoryRules?: CategoryContextRule[]
): WalletCategoryItem | undefined {
  if (!text || !text.trim() || !availableCategories || availableCategories.length === 0) {
    return undefined;
  }

  const cleanText = text.trim();

  // 1. Prioritize explicit category rules if configured
  if (categoryRules && categoryRules.length > 0) {
    const semanticResult = resolveSemanticCategoryHint(
      cleanText,
      availableCategories,
      categoryRules
    );
    if (semanticResult.status === 'RESOLVED') {
      const match = availableCategories.find(c => c.id === semanticResult.id);
      if (match && match.isAssignable !== false && match.group?.id !== 'system_categories') {
        return match;
      }
    }
  }

  // 2. Score using token similarity, keyword clusters, and synonyms
  return selectBestCategory('', [], availableCategories, cleanText);
}
