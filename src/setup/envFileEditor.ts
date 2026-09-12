import dotenv from 'dotenv';

export type EnvironmentValueMap = Record<string, string>;

const ENV_ASSIGNMENT_PATTERN = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;
const UNQUOTED_ENV_VALUE_PATTERN = /^[A-Za-z0-9_./,:@+\-]*$/;

export function parseEnvFileContent(content: string): EnvironmentValueMap {
  return dotenv.parse(content);
}

export function serializeEnvValue(value: string): string {
  if (UNQUOTED_ENV_VALUE_PATTERN.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

export function mergeEnvFileContent(
  existingContent: string,
  updates: EnvironmentValueMap
): string {
  const updateEntries = Object.entries(updates);
  if (updateEntries.length === 0) {
    return existingContent;
  }

  const pendingKeys = new Set(updateEntries.map(([key]) => key));
  const existingLines = existingContent.length > 0 ? existingContent.split(/\r?\n/) : [];

  const mergedLines = existingLines.map(line => {
    const assignmentMatch = line.match(ENV_ASSIGNMENT_PATTERN);
    if (!assignmentMatch) {
      return line;
    }

    const [, prefix, variableName, assignmentSpacing] = assignmentMatch;
    const replacementValue = updates[variableName];
    if (replacementValue === undefined) {
      return line;
    }

    pendingKeys.delete(variableName);
    return `${prefix}${variableName}${assignmentSpacing}${serializeEnvValue(replacementValue)}`;
  });

  const appendedLines = Array.from(pendingKeys).map(
    variableName => `${variableName}=${serializeEnvValue(updates[variableName])}`
  );

  if (appendedLines.length > 0) {
    while (mergedLines.length > 0 && mergedLines[mergedLines.length - 1] === '') {
      mergedLines.pop();
    }

    if (mergedLines.length > 0) {
      mergedLines.push('');
    }
    mergedLines.push('# Added by npm run setup');
    mergedLines.push(...appendedLines);
  }

  return `${mergedLines.join('\n')}\n`;
}
