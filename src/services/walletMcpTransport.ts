import {
  Client,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type ClientOptions,
  type Implementation,
  type ListToolsResult,
  type StreamableHTTPClientTransportOptions,
  type Transport,
} from '@modelcontextprotocol/client';

export const WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS = 15_000;
export const WALLET_MCP_LIST_MAX_PAGES = 8;

export type WalletMcpSdkClient = Pick<
  Client,
  'connect' | 'callTool' | 'listTools' | 'close'
>;

export interface WalletMcpTransportDependencies {
  readonly createClient?: (
    clientInfo: Implementation,
    options: ClientOptions
  ) => WalletMcpSdkClient;
  readonly createTransport?: (
    endpoint: URL,
    options: StreamableHTTPClientTransportOptions
  ) => Transport;
}

const WALLET_MCP_CLIENT_INFO: Implementation = {
  name: 'wallet-mcp-budgetbakers-bot',
  version: '0.1.6',
};

/**
 * Owns only official MCP client lifecycle and transport mechanics. Wallet-specific
 * tool policy, response normalization, and mutation outcome classification remain
 * in WalletMcpClientService.
 */
export class WalletMcpTransport {
  private readonly endpoint: URL;
  private readonly createClient: NonNullable<WalletMcpTransportDependencies['createClient']>;
  private readonly createTransport: NonNullable<WalletMcpTransportDependencies['createTransport']>;
  private activeClient: WalletMcpSdkClient | undefined;
  private pendingClient: Promise<WalletMcpSdkClient> | undefined;

  constructor(
    baseUrl: string,
    private readonly accessToken: string,
    dependencies: WalletMcpTransportDependencies = {}
  ) {
    this.endpoint = new URL(baseUrl);
    this.createClient = dependencies.createClient ?? ((clientInfo, options) => new Client(clientInfo, options));
    this.createTransport = dependencies.createTransport ?? (
      (endpoint, options) => new StreamableHTTPClientTransport(endpoint, options)
    );
  }

  public async callTool(
    name: string,
    toolArguments: Record<string, unknown>
  ): Promise<CallToolResult> {
    const client = await this.getConnectedClient();
    try {
      return await client.callTool(
        { name, arguments: toolArguments },
        {
          timeout: WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS,
          maxTotalTimeout: WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS,
          allowInputRequired: false,
        }
      );
    } catch (error) {
      if (this.isUnusableConnectionError(error)) {
        await this.discardClient(client);
      }
      throw error;
    }
  }

  public async listTools(): Promise<ListToolsResult> {
    const client = await this.getConnectedClient();
    try {
      return await client.listTools(undefined, {
        timeout: WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS,
        maxTotalTimeout: WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS,
        cacheMode: 'refresh',
      });
    } catch (error) {
      if (this.isUnusableConnectionError(error)) {
        await this.discardClient(client);
      }
      throw error;
    }
  }

  public async close(): Promise<void> {
    const pendingClient = this.pendingClient;
    let client = this.activeClient;
    this.activeClient = undefined;
    this.pendingClient = undefined;
    if (!client && pendingClient) {
      try {
        client = await pendingClient;
      } catch {
        return;
      }
      this.activeClient = undefined;
    }
    if (client) {
      await client.close();
    }
  }

  private async getConnectedClient(): Promise<WalletMcpSdkClient> {
    if (this.activeClient) {
      return this.activeClient;
    }
    if (this.pendingClient) {
      return await this.pendingClient;
    }

    const pendingClient = this.connectClient();
    this.pendingClient = pendingClient;

    try {
      const client = await pendingClient;
      this.activeClient = client;
      return client;
    } finally {
      if (this.pendingClient === pendingClient) {
        this.pendingClient = undefined;
      }
    }
  }

  private async connectClient(): Promise<WalletMcpSdkClient> {
    const client = this.createClient(WALLET_MCP_CLIENT_INFO, {
      enforceStrictCapabilities: true,
      inputRequired: { autoFulfill: false },
      listMaxPages: WALLET_MCP_LIST_MAX_PAGES,
      versionNegotiation: {
        mode: 'auto',
        probe: {
          timeoutMs: WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS,
          maxRetries: 0,
        },
      },
    });
    const transport = this.createTransport(this.endpoint, {
      authProvider: {
        token: async () => this.accessToken || undefined,
      },
      onInsufficientScope: 'throw',
      maxStepUpRetries: 0,
      reconnectionOptions: {
        maxReconnectionDelay: 1_000,
        initialReconnectionDelay: 1_000,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
    });

    try {
      await client.connect(transport, {
        timeout: WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS,
        maxTotalTimeout: WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS,
      });
      return client;
    } catch (error) {
      try {
        await client.close();
      } catch {
        // Preserve the original connection failure.
      }
      throw error;
    }
  }

  private async discardClient(client: WalletMcpSdkClient): Promise<void> {
    if (this.activeClient === client) {
      this.activeClient = undefined;
    }
    try {
      await client.close();
    } catch {
      // Preserve the original request failure.
    }
  }

  private isUnusableConnectionError(error: unknown): boolean {
    return error instanceof SdkError && (
      error.code === SdkErrorCode.NotConnected
      || error.code === SdkErrorCode.ConnectionClosed
      || error.code === SdkErrorCode.SendFailed
    );
  }
}
