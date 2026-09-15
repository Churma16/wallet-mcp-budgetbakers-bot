import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type FetchLike,
} from '@modelcontextprotocol/client';
import { redactSensitiveData } from '../utils/logger.js';

const WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS = 15_000;

export interface WalletMcpProtocolToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface WalletMcpProtocolToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface WalletMcpProtocolClient {
  callTool(
    toolName: string,
    toolArguments?: Record<string, unknown>
  ): Promise<WalletMcpProtocolToolResult>;
  listTools(): Promise<WalletMcpProtocolToolDefinition[]>;
  close(): Promise<void>;
}

export interface OfficialWalletMcpProtocolClientOptions {
  fetch?: FetchLike;
}

/**
 * Owns the official MCP client and Streamable HTTP lifecycle. Wallet-specific
 * normalization and authorization policy deliberately remain in the adapter.
 */
export class OfficialWalletMcpProtocolClient implements WalletMcpProtocolClient {
  private client: Client | undefined;
  private connectionPromise: Promise<Client> | undefined;

  constructor(
    private readonly endpointUrl: string,
    private readonly accessToken: string,
    private readonly options: OfficialWalletMcpProtocolClientOptions = {}
  ) {}

  public async callTool(
    toolName: string,
    toolArguments: Record<string, unknown> = {}
  ): Promise<WalletMcpProtocolToolResult> {
    const client = await this.getConnectedClient();
    try {
      return await client.callTool(
        { name: toolName, arguments: toolArguments },
        {
          timeout: WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS,
          maxTotalTimeout: WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS,
        }
      ) as WalletMcpProtocolToolResult;
    } catch (error) {
      await this.discardConnection();
      throw error;
    }
  }

  public async listTools(): Promise<WalletMcpProtocolToolDefinition[]> {
    const client = await this.getConnectedClient();
    try {
      const result = await client.listTools(undefined, {
        timeout: WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS,
        maxTotalTimeout: WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS,
        cacheMode: 'refresh',
      });
      return result.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
        outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
      }));
    } catch (error) {
      await this.discardConnection();
      throw error;
    }
  }

  public async close(): Promise<void> {
    await this.discardConnection();
  }

  private async getConnectedClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }
    if (this.connectionPromise) {
      return await this.connectionPromise;
    }

    this.connectionPromise = this.connect();
    try {
      this.client = await this.connectionPromise;
      return this.client;
    } finally {
      this.connectionPromise = undefined;
    }
  }

  private async connect(): Promise<Client> {
    const client = new Client(
      { name: 'wallet-mcp-budgetbakers-bot', version: '0.1.6' },
      { versionNegotiation: { mode: 'auto' } }
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.endpointUrl), {
      authProvider: {
        token: async () => this.accessToken || undefined,
      },
      fetch: this.options.fetch,
      requestInit: {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    });

    try {
      await client.connect(transport, {
        timeout: WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS,
        maxTotalTimeout: WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS,
      });
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async discardConnection(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connectionPromise = undefined;
    if (client) {
      await client.close().catch(() => undefined);
    }
  }
}

export type WalletMcpProtocolFailureOutcome = 'DEFINITIVE_FAILURE' | 'UNKNOWN';

/**
 * Protocol/tool rejections are authoritative. Transport and response-integrity
 * failures remain uncertain because a financial mutation may already have committed.
 */
export function classifyWalletMcpProtocolFailure(error: unknown): WalletMcpProtocolFailureOutcome | undefined {
  if (error instanceof ProtocolError) {
    return 'DEFINITIVE_FAILURE';
  }

  if (error instanceof SdkHttpError) {
    return error.status === 408 || error.status >= 500 ? 'UNKNOWN' : 'DEFINITIVE_FAILURE';
  }

  if (error instanceof SdkError) {
    if (
      error.code === SdkErrorCode.CapabilityNotSupported ||
      error.code === SdkErrorCode.MethodNotSupportedByProtocolVersion ||
      error.code === SdkErrorCode.NotInitialized
    ) {
      return 'DEFINITIVE_FAILURE';
    }
    return 'UNKNOWN';
  }

  if (error instanceof Error && (error.name === 'AbortError' || error instanceof TypeError)) {
    return 'UNKNOWN';
  }

  return undefined;
}

export function formatWalletMcpProtocolError(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  return redactSensitiveData(rawMessage);
}
