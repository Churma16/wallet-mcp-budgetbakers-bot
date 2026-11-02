import type {
  WalletAccountItem,
  WalletCategoryItem,
  WalletLabelItem,
} from './types.js';
import { applicationLogger } from '../lib/logger.js';

export interface WalletEntityFetcher {
  fetchAccounts(): Promise<WalletAccountItem[]>;
  fetchCategories(): Promise<WalletCategoryItem[]>;
  fetchLabels(): Promise<WalletLabelItem[]>;
}

export interface WalletCacheOptions {
  readonly cacheDurationMilliseconds?: number;
}

export const DEFAULT_METADATA_CACHE_DURATION_MS = 1000 * 60 * 30; // 30 minutes

/**
 * In-memory TTL cache for bank accounts, categories, and labels.
 * Provides fast synchronous lookups, isolated per-domain freshness tracking,
 * and on-demand refresh delegation to the upstream Wallet MCP client.
 */
export class WalletCache {
  private cachedAccountList: WalletAccountItem[] = [];
  private cachedCategoryList: WalletCategoryItem[] = [];
  private cachedLabelList: WalletLabelItem[] = [];
  private labelsLoadedSuccessfully: boolean = false;

  private accountsLastUpdatedTimestamp: number = 0;
  private categoriesLastUpdatedTimestamp: number = 0;
  private labelsLastUpdatedTimestamp: number = 0;
  private readonly cacheDurationMilliseconds: number;

  constructor(
    private readonly client: WalletEntityFetcher,
    options?: WalletCacheOptions
  ) {
    this.cacheDurationMilliseconds =
      options?.cacheDurationMilliseconds ?? DEFAULT_METADATA_CACHE_DURATION_MS;
  }

  public async initialize(): Promise<void> {
    this.cachedAccountList = await this.client
      .fetchAccounts()
      .then(accounts => {
        this.accountsLastUpdatedTimestamp = Date.now();
        return accounts;
      })
      .catch(fetchError => {
        this.accountsLastUpdatedTimestamp = 0;
        applicationLogger.error(
          `Failed to fetch accounts during cache initialization: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`
        );
        return [];
      });

    this.cachedCategoryList = await this.client
      .fetchCategories()
      .then(categories => {
        this.categoriesLastUpdatedTimestamp = Date.now();
        return categories;
      })
      .catch(fetchError => {
        this.categoriesLastUpdatedTimestamp = 0;
        applicationLogger.error(
          `Failed to fetch categories during cache initialization: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`
        );
        return [];
      });

    try {
      this.cachedLabelList = await this.client.fetchLabels();
      this.labelsLoadedSuccessfully = true;
      this.labelsLastUpdatedTimestamp = Date.now();
    } catch (fetchError) {
      this.labelsLoadedSuccessfully = false;
      this.labelsLastUpdatedTimestamp = 0;
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

  public isAccountsFresh(): boolean {
    if (this.cachedAccountList.length === 0 || this.accountsLastUpdatedTimestamp === 0) {
      return false;
    }
    return Date.now() - this.accountsLastUpdatedTimestamp < this.cacheDurationMilliseconds;
  }

  public isCategoriesFresh(): boolean {
    if (this.cachedCategoryList.length === 0 || this.categoriesLastUpdatedTimestamp === 0) {
      return false;
    }
    return Date.now() - this.categoriesLastUpdatedTimestamp < this.cacheDurationMilliseconds;
  }

  public isLabelsFresh(): boolean {
    if (!this.labelsLoadedSuccessfully || this.labelsLastUpdatedTimestamp === 0) {
      return false;
    }
    return Date.now() - this.labelsLastUpdatedTimestamp < this.cacheDurationMilliseconds;
  }

  public async getOrFetchAccounts(forceRefresh: boolean = false): Promise<WalletAccountItem[]> {
    if (!forceRefresh && this.isAccountsFresh()) {
      return this.cachedAccountList;
    }
    return this.refreshAccounts();
  }

  public async getOrFetchCategories(forceRefresh: boolean = false): Promise<WalletCategoryItem[]> {
    if (!forceRefresh && this.isCategoriesFresh()) {
      return this.cachedCategoryList;
    }
    return this.refreshCategories();
  }

  public async getOrFetchLabels(forceRefresh: boolean = false): Promise<WalletLabelItem[]> {
    if (!forceRefresh && this.isLabelsFresh()) {
      return this.cachedLabelList;
    }
    return this.refreshLabels();
  }

  public async refreshAccounts(): Promise<WalletAccountItem[]> {
    this.cachedAccountList = await this.client.fetchAccounts();
    this.accountsLastUpdatedTimestamp = Date.now();
    return this.cachedAccountList;
  }

  public async refreshCategories(): Promise<WalletCategoryItem[]> {
    this.cachedCategoryList = await this.client.fetchCategories();
    this.categoriesLastUpdatedTimestamp = Date.now();
    return this.cachedCategoryList;
  }

  public async refreshLabels(): Promise<WalletLabelItem[]> {
    try {
      this.cachedLabelList = await this.client.fetchLabels();
      this.labelsLoadedSuccessfully = true;
      this.labelsLastUpdatedTimestamp = Date.now();
      return this.cachedLabelList;
    } catch (error) {
      this.labelsLoadedSuccessfully = false;
      this.labelsLastUpdatedTimestamp = 0;
      throw error;
    }
  }

  public invalidateAccounts(): void {
    this.accountsLastUpdatedTimestamp = 0;
  }

  public invalidateCategories(): void {
    this.categoriesLastUpdatedTimestamp = 0;
  }

  public invalidateLabels(): void {
    this.labelsLastUpdatedTimestamp = 0;
    this.labelsLoadedSuccessfully = false;
  }

  public invalidateAll(): void {
    this.invalidateAccounts();
    this.invalidateCategories();
    this.invalidateLabels();
  }

  public getAccountsTimestamp(): number {
    return this.accountsLastUpdatedTimestamp;
  }

  public getAccountsLastUpdatedTimestamp(): number {
    return this.accountsLastUpdatedTimestamp;
  }

  public getCategoriesTimestamp(): number {
    return this.categoriesLastUpdatedTimestamp;
  }

  public getCategoriesLastUpdatedTimestamp(): number {
    return this.categoriesLastUpdatedTimestamp;
  }

  public getLabelsTimestamp(): number {
    return this.labelsLastUpdatedTimestamp;
  }

  public getLabelsLastUpdatedTimestamp(): number {
    return this.labelsLastUpdatedTimestamp;
  }

  public getCacheDurationMilliseconds(): number {
    return this.cacheDurationMilliseconds;
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
    this.labelsLoadedSuccessfully = true;
    this.labelsLastUpdatedTimestamp = Date.now();
  }
}

export const WalletCacheService = WalletCache;
export type WalletCacheService = WalletCache;
