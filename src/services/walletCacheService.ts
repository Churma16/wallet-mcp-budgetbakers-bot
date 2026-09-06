import { WalletAccountItem, WalletCategoryItem } from '../types/walletTypes.js';
import { WalletMcpClientService } from './walletMcpClient.js';
import { applicationLogger } from '../utils/logger.js';

export class WalletCacheService {
  private cachedAccountList: WalletAccountItem[] = [];
  private cachedCategoryList: WalletCategoryItem[] = [];

  constructor(private readonly walletMcpClient: WalletMcpClientService) {}

  /**
   * Initializes cache by fetching initial accounts and categories from Wallet MCP
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

    applicationLogger.success(
      `Cached ${this.cachedAccountList.length} accounts and ${this.cachedCategoryList.length} categories.`
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
}
