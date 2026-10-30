import type { WalletLabelItem } from './types.js';
import { deduplicateTags } from '../utils/hashtagParser.js';
import { applicationLogger } from '../utils/logger.js';

export interface LabelResolverCache {
  findLabelByName(nameHint: string): WalletLabelItem | undefined;
  refreshLabels(): Promise<WalletLabelItem[]>;
  isLabelsLoaded?(): boolean;
  addLabelToCache(label: WalletLabelItem): void;
}

export interface LabelCreatorClient {
  createLabel(name: string): Promise<WalletLabelItem | null>;
}

export interface ResolvedLabelsResult {
  resolvedLabelIds: string[];
  resolvedLabelNames: string[];
  unresolvedLabelNames: string[];
}

export async function resolveAndEnsureLabels(
  tagNames: string[],
  cache: LabelResolverCache,
  client: LabelCreatorClient
): Promise<ResolvedLabelsResult> {
  if (!tagNames || tagNames.length === 0) {
    return { resolvedLabelIds: [], resolvedLabelNames: [], unresolvedLabelNames: [] };
  }

  const uniqueNormalizedTags = deduplicateTags(tagNames);
  const resolvedLabelIds: string[] = [];
  const resolvedLabelNames: string[] = [];
  const unresolvedLabelNames: string[] = [];

  for (const tagName of uniqueNormalizedTags) {
    let existingLabel = cache.findLabelByName(tagName);
    const isCacheLoadedInitially = typeof cache.isLabelsLoaded === 'function'
      ? cache.isLabelsLoaded()
      : true;

    if (!existingLabel && !isCacheLoadedInitially) {
      try {
        await cache.refreshLabels();
        existingLabel = cache.findLabelByName(tagName);
      } catch (refreshError) {
        applicationLogger.warn(
          `[Label Resolver] Could not refresh labels from Wallet MCP to verify "${tagName}": ${
            refreshError instanceof Error ? refreshError.message : String(refreshError)
          }`
        );
      }
    }

    if (existingLabel) {
      if (!resolvedLabelIds.includes(existingLabel.id)) {
        resolvedLabelIds.push(existingLabel.id);
      }
      if (!resolvedLabelNames.includes(existingLabel.name)) {
        resolvedLabelNames.push(existingLabel.name);
      }
      continue;
    }

    const isCacheLoadedNow = typeof cache.isLabelsLoaded === 'function'
      ? cache.isLabelsLoaded()
      : true;

    if (!isCacheLoadedNow) {
      applicationLogger.warn(
        `[Label Resolver] Cannot verify absence of label "${tagName}" due to label listing read failure; skipping auto-creation.`
      );
      if (!unresolvedLabelNames.includes(tagName)) {
        unresolvedLabelNames.push(tagName);
      }
      continue;
    }

    applicationLogger.info(`[Label Resolver] Attempting auto-creation for missing label: "${tagName}"`);
    const createdLabel = await client.createLabel(tagName).catch(creationError => {
      applicationLogger.warn(
        `[Label Resolver] Label auto-creation failed for "${tagName}": ${
          creationError instanceof Error ? creationError.message : String(creationError)
        }`
      );
      return null;
    });

    if (createdLabel) {
      cache.addLabelToCache(createdLabel);
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
      if (!unresolvedLabelNames.includes(tagName)) {
        unresolvedLabelNames.push(tagName);
      }
      applicationLogger.warn(
        `[Label Resolver] Label "${tagName}" could not be created in Wallet MCP; continuing without label ID.`
      );
    }
  }

  return {
    resolvedLabelIds,
    resolvedLabelNames,
    unresolvedLabelNames,
  };
}
