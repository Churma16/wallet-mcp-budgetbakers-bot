import { applicationLogger } from '../../utils/logger.js';

/**
 * Robustly extracts and parses a JSON object from arbitrary LLM response text.
 * Strips reasoning tokens (<think>...</think>), markdown code blocks, and extraneous chatter.
 */
export function extractAndParseJsonObject<T>(rawResponseText: string): T {
  let sanitizedText = rawResponseText.trim();

  // Strip DeepSeek / reasoning thoughts block if present: <think>...</think>
  sanitizedText = sanitizedText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Check if enclosed inside markdown code block
  const markdownBlockMatch = sanitizedText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (markdownBlockMatch && markdownBlockMatch[1]) {
    sanitizedText = markdownBlockMatch[1].trim();
  }

  // Fast path direct JSON parse
  try {
    return JSON.parse(sanitizedText) as T;
  } catch {
    // Fallback: extract the first contiguous JSON object matching { ... }
    const firstBraceIndex = sanitizedText.indexOf('{');
    const lastBraceIndex = sanitizedText.lastIndexOf('}');

    if (firstBraceIndex !== -1 && lastBraceIndex !== -1 && lastBraceIndex > firstBraceIndex) {
      const extractedJsonSubstring = sanitizedText.substring(firstBraceIndex, lastBraceIndex + 1);
      try {
        return JSON.parse(extractedJsonSubstring) as T;
      } catch (parseError: unknown) {
        const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
        applicationLogger.fileDetail('error', 'Failed substring JSON parse attempt', {
          errorMessage,
          extractedJsonSubstring,
        });
        throw new Error(`Unable to parse JSON from AI response: ${errorMessage}`);
      }
    }

    throw new Error('No valid JSON object structure found in AI response');
  }
}
