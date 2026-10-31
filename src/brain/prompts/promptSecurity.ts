import { WalletCategoryItem } from '../../wallet/index.js';

export type UntrustedPromptRegionName = 'untrusted_email_content' | 'untrusted_receipt_text' | 'untrusted_user_text';

/**
 * Escapes external text before placing it inside an XML-like prompt boundary.
 */
function escapeUntrustedPromptText(untrustedText: string): string {
  return untrustedText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Wraps external content in a stable passive-data boundary that cannot be closed
 * by delimiter-looking text supplied inside the payload.
 */
export function wrapUntrustedPromptText(
  regionName: UntrustedPromptRegionName,
  untrustedText: string
): string {
  const normalizedText = untrustedText.replace(/\r\n?/g, '\n');
  const escapedText = escapeUntrustedPromptText(normalizedText);

  return `<${regionName} encoding="xml-escaped">\n${escapedText}\n</${regionName}>`;
}

/**
 * Determines whether a category represents a generic parent or catch-all category.
 */
export function isGenericParentCategory(category: WalletCategoryItem): boolean {
  if (category.systemId?.endsWith('__general')) {
    return true;
  }
  const rawGroup = category.group;
  const groupName = (
    typeof rawGroup === 'string'
      ? rawGroup
      : rawGroup?.name || rawGroup?.id || ''
  ).trim().toLowerCase();

  const categoryName = category.name.trim().toLowerCase();
  if (
    groupName &&
    (categoryName === groupName ||
      (typeof rawGroup === 'object' && rawGroup.id && categoryName === rawGroup.id.toLowerCase()))
  ) {
    return true;
  }

  const universalGenerics = ['others', 'general', 'umum', 'lain-lain', 'lain', 'uncategorized'];
  return universalGenerics.includes(categoryName);
}
