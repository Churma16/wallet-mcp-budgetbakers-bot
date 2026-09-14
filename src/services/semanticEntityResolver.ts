import { CategoryContextRule } from '../types/categoryContextTypes.js';
import { WalletAccountItem, WalletCategoryItem } from '../types/walletTypes.js';

export type SemanticEntityResolutionReason = 'AMBIGUOUS' | 'UNRESOLVED';

export interface SemanticEntityCandidate {
  readonly id: string;
  readonly name: string;
}

export type SemanticEntityResolution =
  | { readonly status: 'RESOLVED'; readonly id: string; readonly name: string; readonly matchedBy: 'ID' | 'INDEX' | 'EXACT_NAME' | 'ACCOUNT_NUMBER' | 'SEMANTIC' }
  | { readonly status: 'CLARIFICATION_REQUIRED'; readonly reason: SemanticEntityResolutionReason; readonly hint: string; readonly candidates: SemanticEntityCandidate[] };

export interface SemanticRecordEntityHints {
  readonly accountHint?: string;
  readonly categoryHint?: string;
}

const normalize = (value: string): string => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('id-ID')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const words = (value: string): string[] => normalize(value).split(' ').filter(Boolean);

function unique<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map(item => [item.id, item])).values()];
}

function unresolved(hint: string, candidates: SemanticEntityCandidate[] = []): SemanticEntityResolution {
  return {
    status: 'CLARIFICATION_REQUIRED',
    reason: candidates.length > 1 ? 'AMBIGUOUS' : 'UNRESOLVED',
    hint,
    candidates: candidates.map(candidate => ({ id: candidate.id, name: candidate.name })),
  };
}

function resolved(item: SemanticEntityCandidate, matchedBy: Extract<SemanticEntityResolution, { status: 'RESOLVED' }>['matchedBy']): SemanticEntityResolution {
  return { status: 'RESOLVED', id: item.id, name: item.name, matchedBy };
}

/** Resolves an untrusted account hint exclusively against the supplied Wallet cache snapshot. */
export function resolveSemanticAccountHint(hint: string, accounts: readonly WalletAccountItem[]): SemanticEntityResolution {
  const rawHint = hint.trim();
  if (!rawHint) return unresolved(rawHint);

  const idMatches = accounts.filter(account => account.id === rawHint);
  if (idMatches.length === 1) return resolved(idMatches[0], 'ID');

  const normalizedHint = normalize(rawHint);
  const candidates: WalletAccountItem[] = [];
  if (/^\d+$/.test(rawHint)) {
    const index = Number.parseInt(rawHint, 10) - 1;
    if (index >= 0 && index < accounts.length) candidates.push(accounts[index]);
  }

  const exactNames = accounts.filter(account => normalize(account.name) === normalizedHint);
  candidates.push(...exactNames);

  if (exactNames.length === 0 && normalizedHint.length > 1) {
    candidates.push(...accounts.filter(account => {
      const candidate = normalize(account.name);
      return candidate.includes(normalizedHint) || normalizedHint.includes(candidate);
    }));
  }

  const digits = rawHint.replace(/\D/g, '');
  if (digits.length >= 4) {
    const numberMatches = accounts.filter(account => {
      const candidate = account.bankAccountNumber?.replace(/\D/g, '') ?? '';
      return Boolean(candidate) && (candidate === digits || candidate.endsWith(digits) || digits.endsWith(candidate));
    });
    candidates.push(...numberMatches);
  }

  const uniqueCandidates = unique(candidates);
  if (uniqueCandidates.length === 1) {
    const match = uniqueCandidates[0];
    const matchedBy = exactNames.some(item => item.id === match.id)
      ? 'EXACT_NAME'
      : /^\d+$/.test(rawHint) && accounts[Number.parseInt(rawHint, 10) - 1]?.id === match.id
        ? 'INDEX'
        : digits.length >= 4 && match.bankAccountNumber
          ? 'ACCOUNT_NUMBER'
          : 'SEMANTIC';
    return resolved(match, matchedBy);
  }
  return unresolved(rawHint, uniqueCandidates);
}

/** Resolves category meaning against Wallet categories plus application-owned category rules. */
export function resolveSemanticCategoryHint(
  hint: string,
  categories: readonly WalletCategoryItem[],
  categoryRules: readonly CategoryContextRule[] = []
): SemanticEntityResolution {
  const rawHint = hint.trim();
  if (!rawHint) return unresolved(rawHint);

  const idMatches = categories.filter(category => category.id === rawHint);
  if (idMatches.length === 1) return resolved(idMatches[0], 'ID');

  const normalizedHint = normalize(rawHint);
  const exactNames = categories.filter(category => normalize(category.name) === normalizedHint);
  if (exactNames.length === 1) return resolved(exactNames[0], 'EXACT_NAME');
  if (exactNames.length > 1) return unresolved(rawHint, exactNames);

  if (/^\d+$/.test(rawHint)) {
    const index = Number.parseInt(rawHint, 10) - 1;
    if (index >= 0 && index < categories.length) return resolved(categories[index], 'INDEX');
  }

  const hintWords = new Set(words(rawHint));
  const matchedIds = new Set<string>();
  for (const category of categories) {
    const categoryText = normalize(category.name);
    if (normalizedHint.length > 2 && (categoryText.includes(normalizedHint) || normalizedHint.includes(categoryText))) {
      matchedIds.add(category.id);
    }

    for (const rule of categoryRules) {
      if (normalize(rule.category) !== categoryText && rule.category !== category.id) continue;
      const excluded = (rule.exclusions ?? []).some(value => words(value).some(word => hintWords.has(word)));
      if (excluded) continue;
      const semanticText = [rule.scope, ...(rule.examples ?? [])].filter(Boolean).join(' ');
      if (words(semanticText).some(word => hintWords.has(word))) matchedIds.add(category.id);
    }
  }

  const semanticMatches = categories.filter(category => matchedIds.has(category.id));
  if (semanticMatches.length === 1) return resolved(semanticMatches[0], 'SEMANTIC');
  return unresolved(rawHint, semanticMatches);
}
