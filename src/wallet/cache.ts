import type {
  WalletAccountItem,
  WalletCategoryItem,
  WalletLabelItem,
} from './types.js';
import { applicationLogger } from '../utils/logger.js';

export interface WalletEntityFetcher {
  fetchAccounts(forceRefresh?: boolean): Promise<WalletAccountItem[]>;
  fetchCategories(forceRefresh?: boolean): Promise<WalletCategoryItem[]>;
  fetchLabels(forceRefresh?: boolean): Promise<WalletLabelItem[]>;
}

/**
 * In-memory TTL cache for bank accounts, categories, and labels.
 * Provides fast synchronous lookups and controlled asynchronous refresh via the Wallet MCP client.
 */
export class WalletCache {
  private cachedAccountList: WalletAccountItem[] = [];
  private cachedCategoryList: WalletCategoryItem[] = [];
  private cachedLabelList: WalletLabelItem[] = [];
  private labelsLoadedSuccessfully: boolean = false;

  constructor(private readonly client: WalletEntityFetcher) {}

  public async initialize(): Promise<void> {
    this.cachedAccountList = await this.client.fetchAccounts(true).catch(fetchError => {
      applicationLogger.error(`Failed to fetch accounts during cache initialization: ${fetchError.message}`);
      return [];
    });

    this.cachedCategoryList = await this.client.fetchCategories(true).catch(fetchError => {
      applicationLogger.error(`Failed to fetch categories during cache initialization: ${fetchError.message}`);
      return [];
    });

    try {
      this.cachedLabelList = await this.client.fetchLabels(true);
      this.labelsLoadedSuccessfully = true;
    } catch (fetchError) {
      this.labelsLoadedSuccessfully = false;
      applicationLogger.warn(
        `Failed to fetch labels during cache initialization: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`
      );
      this.cachedLabelList = [];
    }

    applicationLogger.success(
      `Cached ${this.cachedAccountList.length} accounts, ${this.cachedCategoryList.length} categories, and ${this.cachedLabelList.length} labels.`
    );
  }

  public getAccounts(): WalletAccountItem[] {
    return this.cachedAccountList;
  }

  public getCategories(): WalletCategoryItem[] {
    return this.cachedCategoryList;
  }

  public getLabels(): WalletLabelItem[] {
    return this.cachedLabelList;
  }

  public async refreshAccounts(): Promise<WalletAccountItem[]> {
    this.cachedAccountList = await this.client.fetchAccounts(true);
    return this.cachedAccountList;
  }

  public async refreshCategories(): Promise<WalletCategoryItem[]> {
    this.cachedCategoryList = await this.client.fetchCategories(true);
    return this.cachedCategoryList;
  }

  public async refreshLabels(): Promise<WalletLabelItem[]> {
    try {
      this.cachedLabelList = await this.client.fetchLabels(true);
      this.labelsLoadedSuccessfully = true;
      return this.cachedLabelList;
    } catch (error) {
      this.labelsLoadedSuccessfully = false;
      throw error;
    }
  }

  public isLabelsLoaded(): boolean {
    return this.labelsLoadedSuccessfully;
  }

  public setLabelsLoaded(isLoaded: boolean): void {
    this.labelsLoadedSuccessfully = isLoaded;
  }

  public findAccountById(accountId: string): WalletAccountItem | undefined {
    return this.cachedAccountList.find(account => account.id === accountId);
  }

  public findAccountByName(nameHint: string): WalletAccountItem | undefined {
    const normalizedNameHint = nameHint.toLowerCase();
    return this.cachedAccountList.find(account => account.name.toLowerCase().includes(normalizedNameHint));
  }

  public findCategoryById(categoryId: string): WalletCategoryItem | undefined {
    return this.cachedCategoryList.find(category => category.id === categoryId);
  }

  public findCategoryByName(nameHint: string): WalletCategoryItem | undefined {
    const normalizedNameHint = nameHint.toLowerCase();
    return this.cachedCategoryList.find(category => category.name.toLowerCase().includes(normalizedNameHint));
  }

  public findLabelById(labelId: string): WalletLabelItem | undefined {
    return this.cachedLabelList.find(label => label.id === labelId);
  }

  public findLabelByName(nameHint: string): WalletLabelItem | undefined {
    const normalizedNameHint = nameHint.replace(/^#/, '').trim().toLowerCase();
    return this.cachedLabelList.find(
      label => label.name.replace(/^#/, '').trim().toLowerCase() === normalizedNameHint
    );
  }

  public addLabelToCache(label: WalletLabelItem): void {
    const existingIndex = this.cachedLabelList.findIndex(item => item.id === label.id);
    if (existingIndex >= 0) {
      this.cachedLabelList[existingIndex] = label;
    } else {
      this.cachedLabelList.push(label);
    }
  }
}

export const WalletCacheService = WalletCache;
export type WalletCacheService = WalletCache;
