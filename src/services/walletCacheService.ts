import { WalletAccountItem, WalletCategoryItem, WalletLabelItem } from '../types/walletTypes.js';
import { WalletMcpClientService } from './walletMcpService.js';
import { applicationLogger } from '../utils/logger.js';

export interface WalletCacheOptions {
  readonly cacheDurationMilliseconds?: number;
}

export const DEFAULT_METADATA_CACHE_DURATION_MS = 1000 * 60 * 30; // 30 minutes

export class WalletCacheService {
  private cachedAccountList: WalletAccountItem[] = [];
  private cachedCategoryList: WalletCategoryItem[] = [];
  private cachedLabelList: WalletLabelItem[] = [];
  private labelsLoadedSuccessfully: boolean = false;

  private accountsLastUpdatedTimestamp: number = 0;
  private categoriesLastUpdatedTimestamp: number = 0;
  private labelsLastUpdatedTimestamp: number = 0;
  private readonly cacheDurationMilliseconds: number;

  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    options?: WalletCacheOptions
  ) {
    this.cacheDurationMilliseconds =
      options?.cacheDurationMilliseconds ?? DEFAULT_METADATA_CACHE_DURATION_MS;
  }

  /**
   * Initializes cache by fetching initial accounts, categories, and labels from Wallet MCP
   */
  public async initialize(): Promise<void> {
    const fetchStartTimestamp = Date.now();
    let accountsSuccess = false;
    let categoriesSuccess = false;

    this.cachedAccountList = await this.walletMcpClient
      .fetchAccounts(true)
      .then(accounts => {
        accountsSuccess = true;
        return accounts;
      })
      .catch(fetchError => {
        applicationLogger.error(
          `Failed to fetch accounts during cache initialization: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`
        );
        return [];
      });

    if (accountsSuccess) {
      this.accountsLastUpdatedTimestamp = fetchStartTimestamp;
    }

    this.cachedCategoryList = await this.walletMcpClient
      .fetchCategories(true)
      .then(categories => {
        categoriesSuccess = true;
        return categories;
      })
      .catch(fetchError => {
        applicationLogger.error(
          `Failed to fetch categories during cache initialization: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`
        );
        return [];
      });

    if (categoriesSuccess) {
      this.categoriesLastUpdatedTimestamp = fetchStartTimestamp;
    }

    try {
      this.cachedLabelList = await this.walletMcpClient.fetchLabels(true);
      this.labelsLoadedSuccessfully = true;
      this.labelsLastUpdatedTimestamp = fetchStartTimestamp;
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

  /**
   * Returns current cached accounts list
   */
  public getAccounts(): WalletAccountItem[] {
    return this.cachedAccountList;
  }

  /**
   * Returns current cached categories list
   */
  public getCategories(): WalletCategoryItem[] {
    return this.cachedCategoryList;
  }

  /**
   * Returns current cached labels list
   */
  public getLabels(): WalletLabelItem[] {
    return this.cachedLabelList;
  }

  /**
   * Checks whether the cached accounts data is fresh within the configured TTL
   */
  public isAccountsFresh(currentTime: number = Date.now()): boolean {
    return (
      this.accountsLastUpdatedTimestamp > 0 &&
      currentTime - this.accountsLastUpdatedTimestamp <= this.cacheDurationMilliseconds
    );
  }

  /**
   * Checks whether the cached categories data is fresh within the configured TTL
   */
  public isCategoriesFresh(currentTime: number = Date.now()): boolean {
    return (
      this.categoriesLastUpdatedTimestamp > 0 &&
      currentTime - this.categoriesLastUpdatedTimestamp <= this.cacheDurationMilliseconds
    );
  }

  /**
   * Checks whether the cached labels data is fresh within the configured TTL
   */
  public isLabelsFresh(currentTime: number = Date.now()): boolean {
    return (
      this.labelsLoadedSuccessfully &&
      this.labelsLastUpdatedTimestamp > 0 &&
      currentTime - this.labelsLastUpdatedTimestamp <= this.cacheDurationMilliseconds
    );
  }

  /**
   * Returns the timestamp when accounts were last successfully fetched
   */
  public getAccountsTimestamp(): number {
    return this.accountsLastUpdatedTimestamp;
  }

  /**
   * Returns the timestamp when categories were last successfully fetched
   */
  public getCategoriesTimestamp(): number {
    return this.categoriesLastUpdatedTimestamp;
  }

  /**
   * Returns the timestamp when labels were last successfully fetched
   */
  public getLabelsTimestamp(): number {
    return this.labelsLastUpdatedTimestamp;
  }

  /**
   * Invalidates accounts cache freshness
   */
  public invalidateAccounts(): void {
    this.accountsLastUpdatedTimestamp = 0;
  }

  /**
   * Invalidates categories cache freshness
   */
  public invalidateCategories(): void {
    this.categoriesLastUpdatedTimestamp = 0;
  }

  /**
   * Invalidates labels cache freshness
   */
  public invalidateLabels(): void {
    this.labelsLastUpdatedTimestamp = 0;
  }

  /**
   * Invalidates all metadata cache freshness
   */
  public invalidateAll(): void {
    this.invalidateAccounts();
    this.invalidateCategories();
    this.invalidateLabels();
  }

  /**
   * Forces a fresh fetch of accounts from Wallet MCP and updates cache
   */
  public async refreshAccounts(): Promise<WalletAccountItem[]> {
    this.cachedAccountList = await this.walletMcpClient.fetchAccounts(true);
    this.accountsLastUpdatedTimestamp = Date.now();
    return this.cachedAccountList;
  }

  /**
   * Forces a fresh fetch of categories from Wallet MCP and updates cache
   */
  public async refreshCategories(): Promise<WalletCategoryItem[]> {
    this.cachedCategoryList = await this.walletMcpClient.fetchCategories(true);
    this.categoriesLastUpdatedTimestamp = Date.now();
    return this.cachedCategoryList;
  }

  /**
   * Forces a fresh fetch of labels from Wallet MCP and updates cache
   */
  public async refreshLabels(): Promise<WalletLabelItem[]> {
    try {
      this.cachedLabelList = await this.walletMcpClient.fetchLabels(true);
      this.labelsLoadedSuccessfully = true;
      this.labelsLastUpdatedTimestamp = Date.now();
      return this.cachedLabelList;
    } catch (error) {
      this.labelsLoadedSuccessfully = false;
      throw error;
    }
  }

  /**
   * Returns cached accounts if fresh, or fetches fresh accounts from Wallet MCP
   */
  public async getOrFetchAccounts(forceRefresh: boolean = false): Promise<WalletAccountItem[]> {
    if (forceRefresh || !this.isAccountsFresh() || this.cachedAccountList.length === 0) {
      return await this.refreshAccounts();
    }
    return this.cachedAccountList;
  }

  /**
   * Returns cached categories if fresh, or fetches fresh categories from Wallet MCP
   */
  public async getOrFetchCategories(forceRefresh: boolean = false): Promise<WalletCategoryItem[]> {
    if (forceRefresh || !this.isCategoriesFresh() || this.cachedCategoryList.length === 0) {
      return await this.refreshCategories();
    }
    return this.cachedCategoryList;
  }

  /**
   * Returns cached labels if fresh, or fetches fresh labels from Wallet MCP
   */
  public async getOrFetchLabels(forceRefresh: boolean = false): Promise<WalletLabelItem[]> {
    if (
      forceRefresh ||
      !this.isLabelsFresh() ||
      (!this.labelsLoadedSuccessfully && this.cachedLabelList.length === 0)
    ) {
      return await this.refreshLabels();
    }
    return this.cachedLabelList;
  }

  /**
   * Indicates whether labels were successfully loaded from Wallet MCP at least once
   */
  public isLabelsLoaded(): boolean {
    return this.labelsLoadedSuccessfully;
  }

  /**
   * Explicitly sets the labels loaded status (useful for seeded caches or tests)
   */
  public setLabelsLoaded(isLoaded: boolean): void {
    this.labelsLoadedSuccessfully = isLoaded;
  }

  /**
   * Searches cached accounts by unique identifier
   */
  public findAccountById(accountId: string): WalletAccountItem | undefined {
    return this.cachedAccountList.find(account => account.id === accountId);
  }

  /**
   * Searches cached accounts by partial or case-insensitive name match
   */
  public findAccountByName(nameHint: string): WalletAccountItem | undefined {
    const normalizedNameHint = nameHint.toLowerCase();
    return this.cachedAccountList.find(account =>
      account.name.toLowerCase().includes(normalizedNameHint)
    );
  }

  /**
   * Searches cached labels by unique identifier
   */
  public findLabelById(labelId: string): WalletLabelItem | undefined {
    return this.cachedLabelList.find(label => label.id === labelId);
  }

  /**
   * Searches cached labels by exact or normalized case-insensitive name match
   */
  public findLabelByName(nameHint: string): WalletLabelItem | undefined {
    const normalizedNameHint = nameHint.replace(/^#/, '').trim().toLowerCase();
    return this.cachedLabelList.find(
      label => label.name.replace(/^#/, '').trim().toLowerCase() === normalizedNameHint
    );
  }

  /**
   * Appends or updates a label in the cache
   */
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
