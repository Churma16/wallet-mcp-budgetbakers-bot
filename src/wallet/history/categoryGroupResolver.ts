/**
 * BudgetBakers Category Group Tree and Alias Matcher.
 * Provides extraction, alias mapping, standardized text matching,
 * and fuzzy candidate resolution for dynamic category groups in transaction history.
 */

import { WalletCategoryItem } from '../types.js';

export const SUPPORTED_BUDGETBAKERS_CATEGORY_GROUPS: readonly string[] = [
  'communication_pc',
  'financial_expenses',
  'food_and_drinks',
  'housing',
  'income',
  'investments',
  'life_entertainment',
  'others',
  'shopping',
  'system_categories',
  'transportation',
  'unknown_records',
  'vehicle',
];

export const MAX_GROUP_CATEGORIES_LIMIT = 50;

export interface DynamicCategoryGroupInfo {
  id: string;
  name: string;
  categoryIds: string[];
  categories: WalletCategoryItem[];
}

export const CATEGORY_GROUP_ALIASES: Readonly<Record<string, string>> = {
  food: 'food_and_drinks',
  makan: 'food_and_drinks',
  makanan: 'food_and_drinks',
  minuman: 'food_and_drinks',
  minum: 'food_and_drinks',
  drink: 'food_and_drinks',
  drinks: 'food_and_drinks',
  'food & drink': 'food_and_drinks',
  'food and drink': 'food_and_drinks',
  'food & drinks': 'food_and_drinks',
  'food and drinks': 'food_and_drinks',
  'makan & minum': 'food_and_drinks',
  'makan dan minum': 'food_and_drinks',
  'makanan & minuman': 'food_and_drinks',
  'makanan dan minuman': 'food_and_drinks',
  transport: 'transportation',
  transportasi: 'transportation',
  belanja: 'shopping',
  shop: 'shopping',
  shopping: 'shopping',
  hiburan: 'life_entertainment',
  entertainment: 'life_entertainment',
  'life & entertainment': 'life_entertainment',
  'life and entertainment': 'life_entertainment',
  'hiburan & gaya hidup': 'life_entertainment',
  'hiburan dan gaya hidup': 'life_entertainment',
  'gaya hidup & hiburan': 'life_entertainment',
  'gaya hidup dan hiburan': 'life_entertainment',
  tagihan: 'financial_expenses',
  bills: 'financial_expenses',
  'financial expense': 'financial_expenses',
  'financial expenses': 'financial_expenses',
  'biaya keuangan': 'financial_expenses',
  investasi: 'investments',
  investment: 'investments',
  rumah: 'housing',
  housing: 'housing',
  kendaraan: 'vehicle',
  vehicle: 'vehicle',
  komunikasi: 'communication_pc',
  communication: 'communication_pc',
  'communication & pc': 'communication_pc',
  'communication and pc': 'communication_pc',
  'komunikasi & pc': 'communication_pc',
  'komunikasi dan pc': 'communication_pc',
};

export function normalizeGroupMatchingText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .replace(/\b(?:dan|and)\b/gi, '&')
    .replace(/\s*&\s*/g, ' & ')
    .replace(/[\s+-]+/g, ' ')
    .trim();
}

export function matchesCategorySubstring(categoryName: string, normalizedHint: string): boolean {
  const normalizedCategoryName = categoryName.toLowerCase().trim();
  const cleanHint = normalizedHint.toLowerCase().trim();
  if (!normalizedCategoryName || !cleanHint) {
    return false;
  }
  if (normalizedCategoryName.includes(cleanHint)) {
    return true;
  }
  const standardizedCategory = normalizeGroupMatchingText(normalizedCategoryName);
  const standardizedHint = normalizeGroupMatchingText(cleanHint);
  if (standardizedCategory.includes(standardizedHint)) {
    return true;
  }
  return false;
}

export function extractDynamicCategoryGroups(
  availableCategoryList: WalletCategoryItem[]
): Map<string, DynamicCategoryGroupInfo> {
  const dynamicGroupMap = new Map<string, DynamicCategoryGroupInfo>();

  for (const categoryItem of availableCategoryList) {
    if (!categoryItem.group) {
      continue;
    }
    const rawGroupId = (
      typeof categoryItem.group === 'string'
        ? categoryItem.group
        : String(categoryItem.group.id || categoryItem.group.name || '')
    ).trim();
    const rawGroupName = (
      typeof categoryItem.group === 'string'
        ? categoryItem.group
        : String(categoryItem.group.name || categoryItem.group.id || '')
    ).trim();

    if (!rawGroupId && !rawGroupName) {
      continue;
    }

    const normalizedGroupId = (rawGroupId || rawGroupName).toLowerCase();
    let existingGroup = dynamicGroupMap.get(normalizedGroupId);
    if (!existingGroup) {
      existingGroup = {
        id: rawGroupId || rawGroupName,
        name: rawGroupName || rawGroupId,
        categoryIds: [],
        categories: [],
      };
      dynamicGroupMap.set(normalizedGroupId, existingGroup);
    }

    if (!existingGroup.categoryIds.includes(categoryItem.id)) {
      existingGroup.categoryIds.push(categoryItem.id);
      existingGroup.categories.push(categoryItem);
    }
  }

  return dynamicGroupMap;
}

export interface DynamicCategoryGroupMatchResult {
  status: 'EXACT_MATCH' | 'FUZZY_MATCH' | 'AMBIGUOUS' | 'NO_MATCH';
  group?: DynamicCategoryGroupInfo;
  candidates?: DynamicCategoryGroupInfo[];
}

export function matchDynamicCategoryGroup(
  groupHint: string,
  dynamicGroupMap: Map<string, DynamicCategoryGroupInfo>
): DynamicCategoryGroupMatchResult {
  const normalizedHint = groupHint.toLowerCase().trim();
  const standardizedHint = normalizeGroupMatchingText(normalizedHint);

  // 1. Direct match on group id
  const directIdMatch = dynamicGroupMap.get(normalizedHint);
  if (directIdMatch) {
    return { status: 'EXACT_MATCH', group: directIdMatch };
  }

  // 2. Direct match on group name (case-insensitive)
  for (const groupEntry of dynamicGroupMap.values()) {
    if (groupEntry.name.toLowerCase() === normalizedHint) {
      return { status: 'EXACT_MATCH', group: groupEntry };
    }
  }

  // 3. Match via alias
  const aliasedGroupId = CATEGORY_GROUP_ALIASES[normalizedHint] || CATEGORY_GROUP_ALIASES[standardizedHint];
  if (aliasedGroupId) {
    const aliasedIdMatch = dynamicGroupMap.get(aliasedGroupId.toLowerCase());
    if (aliasedIdMatch) {
      return { status: 'EXACT_MATCH', group: aliasedIdMatch };
    }
    for (const groupEntry of dynamicGroupMap.values()) {
      if (
        groupEntry.id.toLowerCase() === aliasedGroupId.toLowerCase() ||
        groupEntry.name.toLowerCase() === aliasedGroupId.toLowerCase()
      ) {
        return { status: 'EXACT_MATCH', group: groupEntry };
      }
    }
  }

  // 4. Standardized text match (handles "Food and Drinks" vs "Food & Drinks", "Kebugaran dan Kesehatan" vs "Kebugaran & Kesehatan")
  for (const groupEntry of dynamicGroupMap.values()) {
    const standardizedGroupName = normalizeGroupMatchingText(groupEntry.name);
    const standardizedGroupId = normalizeGroupMatchingText(groupEntry.id);
    if (standardizedGroupName === standardizedHint || standardizedGroupId === standardizedHint) {
      return { status: 'EXACT_MATCH', group: groupEntry };
    }
    if (aliasedGroupId) {
      const standardizedAliasedId = normalizeGroupMatchingText(aliasedGroupId);
      if (standardizedGroupName === standardizedAliasedId || standardizedGroupId === standardizedAliasedId) {
        return { status: 'EXACT_MATCH', group: groupEntry };
      }
    }
  }

  // 5. Slugified name match (e.g. "food_and_drinks" or "food & drinks")
  const slugifiedHint = normalizedHint.replace(/[\s&_-]+/g, '_');
  for (const groupEntry of dynamicGroupMap.values()) {
    const slugifiedGroupName = groupEntry.name.toLowerCase().replace(/[\s&_-]+/g, '_');
    const slugifiedGroupId = groupEntry.id.toLowerCase().replace(/[\s&_-]+/g, '_');
    if (slugifiedGroupName === slugifiedHint || slugifiedGroupId === slugifiedHint) {
      return { status: 'EXACT_MATCH', group: groupEntry };
    }
  }

  // 6. Fuzzy token or substring match against group name or group id.
  // Collect all matching candidate groups to avoid iteration-order dependence and fail closed on ambiguity!
  const fuzzyCandidateMap = new Map<string, DynamicCategoryGroupInfo>();
  for (const groupEntry of dynamicGroupMap.values()) {
    const groupWords = groupEntry.name
      .toLowerCase()
      .split(/[\s&_,./-]+/)
      .filter(w => w.length > 2);
    const groupNameLower = groupEntry.name.toLowerCase();
    const groupIdLower = groupEntry.id.toLowerCase();

    let matched = false;
    if (groupWords.includes(normalizedHint)) {
      matched = true;
    } else if (
      normalizedHint.length >= 3 &&
      (groupNameLower.includes(normalizedHint) || groupIdLower.includes(normalizedHint))
    ) {
      matched = true;
    }

    if (matched) {
      fuzzyCandidateMap.set(groupEntry.id, groupEntry);
    }
  }

  if (fuzzyCandidateMap.size === 1) {
    const singleGroup = Array.from(fuzzyCandidateMap.values())[0];
    return { status: 'FUZZY_MATCH', group: singleGroup };
  } else if (fuzzyCandidateMap.size > 1) {
    const sortedCandidates = Array.from(fuzzyCandidateMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    return { status: 'AMBIGUOUS', candidates: sortedCandidates };
  }

  return { status: 'NO_MATCH' };
}

export function findMatchingDynamicCategoryGroup(
  groupHint: string,
  dynamicGroupMap: Map<string, DynamicCategoryGroupInfo>
): DynamicCategoryGroupInfo | undefined {
  const matchResult = matchDynamicCategoryGroup(groupHint, dynamicGroupMap);
  if (matchResult.status === 'EXACT_MATCH' || matchResult.status === 'FUZZY_MATCH') {
    return matchResult.group;
  }
  return undefined;
}
