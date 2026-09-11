import { WalletAccountItem, WalletCategoryItem, WalletLabelItem } from '../types/walletTypes.js';
import { WalletMcpClientService } from './walletMcpService.js';
import { applicationLogger } from '../utils/logger.js';

export class WalletCacheService {
  private cachedAccountList: WalletAccountItem[] = [];
  private cachedCategoryList: WalletCategoryItem[] = [];
  private cachedLabelList: WalletLabelItem[] = [];

  constructor(private readonly walletMcpClient: WalletMcpClientService) {}

  /**
   * Initializes cache by fetching initial accounts, categories, and labels from Wallet MCP
   */
  public async initialize(): Promise<void> {
    this.cachedAccountList = await this.walletMcpClient.fetchAccounts(true).catch(fetchError => {
      applicationLogger.error(`Failed to fetch accounts during cache initialization: ${fetchError.message}`);
      return [];
    });

    this.cachedCategoryList = await this.walletMcpClient.fetchCategories(true).catch(fetchError => {
      applicationLogger.error(`Failed to fetch categories during cache initialization: ${fetchError.message}`);
      return [];
    });

    this.cachedLabelList = await this.walletMcpClient.fetchLabels(true).catch(fetchError => {
      applicationLogger.warn(`Failed to fetch labels during cache initialization: ${fetchError.message}`);
      return [];
    });

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
   * Forces a fresh fetch of accounts from Wallet MCP and updates cache
   */
  public async refreshAccounts(): Promise<WalletAccountItem[]> {
    this.cachedAccountList = await this.walletMcpClient.fetchAccounts(true);
    return this.cachedAccountList;
  }

  /**
   * Forces a fresh fetch of categories from Wallet MCP and updates cache
   */
  public async refreshCategories(): Promise<WalletCategoryItem[]> {
    this.cachedCategoryList = await this.walletMcpClient.fetchCategories(true);
    return this.cachedCategoryList;
  }

  /**
   * Forces a fresh fetch of labels from Wallet MCP and updates cache
   */
  public async refreshLabels(): Promise<WalletLabelItem[]> {
    this.cachedLabelList = await this.walletMcpClient.fetchLabels(true);
    return this.cachedLabelList;
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
    return this.cachedAccountList.find(account => account.name.toLowerCase().includes(normalizedNameHint));
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
  }
}
