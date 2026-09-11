/**
 * Utility for parsing and normalizing explicit hashtag tokens (#tag)
 * from user input and transaction notes.
 */

const HASHTAG_EXTRACTION_REGEX = /(?:^|[\s([{\<])#([a-zA-Z0-9_\-]+?)(?=[.,!?;:)\]}>]*(?:\s|$))/g;
const HASHTAG_REMOVAL_REGEX = /(?:^|[\s([{\<])#([a-zA-Z0-9_\-]+)[.,!?;:)\]}>]*/g;

/**
 * Normalizes a single tag name by stripping leading '#' and trimming whitespace.
 */
export function normalizeTagName(tag: string): string {
  return tag.replace(/^#+/, '').trim();
}

/**
 * Case-insensitively deduplicates tag names while preserving the casing of the first occurrence.
 */
export function deduplicateTags(tags: string[]): string[] {
  const seenLowercase = new Set<string>();
  const uniqueTagList: string[] = [];

  for (const rawTag of tags) {
    const cleanedTag = normalizeTagName(rawTag);
    if (!cleanedTag) {
      continue;
    }

    const lowercaseKey = cleanedTag.toLowerCase();
    if (!seenLowercase.has(lowercaseKey)) {
      seenLowercase.add(lowercaseKey);
      uniqueTagList.push(cleanedTag);
    }
  }

  return uniqueTagList;
}

export interface ExtractedHashtagsResult {
  tags: string[];
  cleanedText: string;
}

/**
 * Extracts explicit hashtag tokens from text and returns both the normalized unique tags
 * and the cleaned text with hashtag tokens stripped.
 */
export function extractHashtags(sourceText: string): ExtractedHashtagsResult {
  if (!sourceText || typeof sourceText !== 'string') {
    return { tags: [], cleanedText: '' };
  }

  const rawExtractedTags: string[] = [];
  let regexMatch: RegExpExecArray | null;

  // Reset regex index before matching
  HASHTAG_EXTRACTION_REGEX.lastIndex = 0;
  while ((regexMatch = HASHTAG_EXTRACTION_REGEX.exec(sourceText)) !== null) {
    if (regexMatch[1]) {
      rawExtractedTags.push(regexMatch[1]);
    }
  }

  const uniqueTags = deduplicateTags(rawExtractedTags);

  // Clean the text by removing hashtags and tidying residual whitespace/punctuation
  const cleanedText = sourceText
    .replace(HASHTAG_REMOVAL_REGEX, ' ')
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.:;?!])/g, '$1')
    .replace(/^[,\s;:—-]+|[,\s;:—-]+$/g, '')
    .trim();

  return {
    tags: uniqueTags,
    cleanedText,
  };
}
