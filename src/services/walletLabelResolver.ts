import { WalletCacheService } from './walletCacheService.js';
import { WalletMcpClientService } from './walletMcpService.js';
import { deduplicateTags } from '../utils/hashtagParser.js';
import { applicationLogger } from '../utils/logger.js';

export interface ResolvedLabelsResult {
  resolvedLabelIds: string[];
  resolvedLabelNames: string[];
}

/**
 * Resolves a list of tag names against Wallet labels.
 * Reuses existing labels case-insensitively, creates missing labels if the MCP client supports it,
 * and updates cache. Never throws or halts transaction creation if label creation is unsupported.
 */
export async function resolveAndEnsureLabels(
  tagNames: string[],
  walletCacheService: WalletCacheService,
  walletMcpClient: WalletMcpClientService
): Promise<ResolvedLabelsResult> {
  if (!tagNames || tagNames.length === 0) {
    return { resolvedLabelIds: [], resolvedLabelNames: [] };
  }

  const uniqueNormalizedTags = deduplicateTags(tagNames);
  const resolvedLabelIds: string[] = [];
  const resolvedLabelNames: string[] = [];

  for (const tagName of uniqueNormalizedTags) {
    // Check if label exists in cache (case-insensitive)
    const existingLabel = walletCacheService.findLabelByName(tagName);

    if (existingLabel) {
      if (!resolvedLabelIds.includes(existingLabel.id)) {
        resolvedLabelIds.push(existingLabel.id);
      }
      if (!resolvedLabelNames.includes(existingLabel.name)) {
        resolvedLabelNames.push(existingLabel.name);
      }
      continue;
    }

    // Attempt auto-creation of missing label
    applicationLogger.info(`[Label Resolver] Attempting auto-creation for missing label: "${tagName}"`);
    const createdLabel = await walletMcpClient.createLabel(tagName).catch(creationError => {
      applicationLogger.warn(
        `[Label Resolver] Label auto-creation failed for "${tagName}": ${creationError instanceof Error ? creationError.message : String(creationError)}`
      );
      return null;
    });

    if (createdLabel) {
      walletCacheService.addLabelToCache(createdLabel);
      if (!resolvedLabelIds.includes(createdLabel.id)) {
        resolvedLabelIds.push(createdLabel.id);
      }
      if (!resolvedLabelNames.includes(createdLabel.name)) {
        resolvedLabelNames.push(createdLabel.name);
      }
      applicationLogger.success(
        `[Label Resolver] Successfully created and cached new label: "${createdLabel.name}" (${createdLabel.id})`
      );
    } else {
      // Label creation is unavailable or failed; keep name for presentation but omit unresolved ID
      if (!resolvedLabelNames.includes(tagName)) {
        resolvedLabelNames.push(tagName);
      }
      applicationLogger.warn(
        `[Label Resolver] Label "${tagName}" could not be created in Wallet MCP; continuing without label ID.`
      );
    }
  }

  return {
    resolvedLabelIds,
    resolvedLabelNames,
  };
}
