import {
  PendingCategorySelectionCandidate,
  PendingCategorySelectionDraft,
} from '../pendingTransactionService.js';
import { WalletCategoryItem } from '../../types/walletTypes.js';
import {
  formatCategorySelectionPrompt,
} from '../../utils/categoryClarificationFormatter.js';
import { FinancialAiProvider } from './financialAiProvider.js';

export class CategoryClarificationConversationService {
  constructor(private readonly financialAiProvider?: FinancialAiProvider) {}

  public async generateClarificationQuestion(
    draft: PendingCategorySelectionDraft,
    categories: WalletCategoryItem[] = [],
    invalidSelection?: string
  ): Promise<string> {
    return formatCategorySelectionPrompt(draft, categories, invalidSelection);
  }

  public async interpretClarificationReply(
    userReply: string,
    claimedDraft: PendingCategorySelectionDraft,
    availableCategories: WalletCategoryItem[] = []
  ): Promise<PendingCategorySelectionCandidate | undefined> {
    const candidateCategories = claimedDraft.candidateCategories;
    const normalizedReply = userReply.trim();

    // 1. Cheap deterministic numeric fast-path (1-based index)
    const numericMatch = normalizedReply.match(/^\s*#?(\d+)\.?\s*$/);
    if (numericMatch) {
      const selectedIndex = Number.parseInt(numericMatch[1], 10) - 1;
      if (selectedIndex >= 0 && selectedIndex < candidateCategories.length) {
        return candidateCategories[selectedIndex];
      }
      return undefined;
    }

    const lowercasedReply = normalizedReply.toLowerCase();

    // 2. Exact name match against candidate categories
    const exactCandidateMatch = candidateCategories.find(
      candidate => candidate.name.toLowerCase() === lowercasedReply
    );
    if (exactCandidateMatch) {
      return exactCandidateMatch;
    }

    // 3. Substring match against candidate categories
    if (lowercasedReply.length >= 3) {
      const substringCandidateMatches = candidateCategories.filter(
        candidate =>
          candidate.name.toLowerCase().includes(lowercasedReply) ||
          lowercasedReply.includes(candidate.name.toLowerCase())
      );
      if (substringCandidateMatches.length === 1) {
        return substringCandidateMatches[0];
      }
    }

    // 4. Exact name match against any available category in Wallet
    const exactAvailableMatch = availableCategories.find(
      category =>
        category.isAssignable !== false &&
        category.name.toLowerCase() === lowercasedReply
    );
    if (exactAvailableMatch) {
      return {
        id: exactAvailableMatch.id,
        name: exactAvailableMatch.name,
      };
    }

    // 5. Substring match against any available category in Wallet
    if (lowercasedReply.length >= 3) {
      const substringAvailableMatches = availableCategories.filter(
        category =>
          category.isAssignable !== false &&
          (category.name.toLowerCase().includes(lowercasedReply) ||
            lowercasedReply.includes(category.name.toLowerCase()))
      );
      if (substringAvailableMatches.length === 1) {
        return {
          id: substringAvailableMatches[0].id,
          name: substringAvailableMatches[0].name,
        };
      }
    }

    return undefined;
  }

  public async selectBestCategory(
    categoryHint: string,
    candidateCategories: PendingCategorySelectionCandidate[],
    availableCategories: WalletCategoryItem[],
    recordNote?: string
  ): Promise<WalletCategoryItem | undefined> {
    const assignableCategories = availableCategories.filter(
      category => category.isAssignable !== false
    );

    // 1. If candidateCategories already has exactly 1 candidate, use it directly
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

    // Common Indonesian & English semantic category synonyms mapping
    const semanticSynonymMap: Record<string, string[]> = {
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

    const expandedTokens = new Set<string>(searchTokens);
    for (const token of searchTokens) {
      const synonyms = semanticSynonymMap[token];
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

    // 2. If candidates were provided, pick the first one
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
}
