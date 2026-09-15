import { describe, expect, it, vi } from 'vitest';
import {
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  type FetchLike,
} from '@modelcontextprotocol/client';
import {
  WalletMcpClientService,
  WalletMcpRequestError,
} from '../src/services/walletMcpService.js';
import type {
  WalletMcpProtocolClient,
  WalletMcpProtocolToolDefinition,
  WalletMcpProtocolToolResult,
} from '../src/services/walletMcpProtocolClient.js';
import { OfficialWalletMcpProtocolClient } from '../src/services/walletMcpProtocolClient.js';

function createProtocolClient(options: {
  callResult?: WalletMcpProtocolToolResult;
  callError?: unknown;
  tools?: WalletMcpProtocolToolDefinition[];
} = {}): WalletMcpProtocolClient & {
  callTool: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    callTool: options.callError === undefined
      ? vi.fn().mockResolvedValue(options.callResult ?? {})
      : vi.fn().mockRejectedValue(options.callError),
    listTools: vi.fn().mockResolvedValue(options.tools ?? []),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function captureRequestError(operation: () => Promise<unknown>): Promise<WalletMcpRequestError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(WalletMcpRequestError);
    return error as WalletMcpRequestError;
  }
  throw new Error('[FAIL] Expected WalletMcpRequestError');
}

describe('Wallet MCP official SDK boundary (Issue #165)', () => {
  it('initializes the official Streamable HTTP client with bearer authentication', async () => {
    const observedMethods: string[] = [];
    const observedAuthorizationHeaders: Array<string | null> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      observedAuthorizationHeaders.push(request.headers.get('authorization'));
      const body = await request.clone().json() as { id?: string | number; method?: string };
      observedMethods.push(body.method ?? 'unknown');

      if (body.method === 'server/discover') {
        return new Response(null, { status: 404 });
      }
      if (body.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'wallet-fixture', version: '1.0.0' },
          },
        });
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (body.method === 'tools/call') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { structuredContent: { profile: 'ready' }, content: [] },
        });
      }
      throw new Error(`Unexpected MCP fixture method: ${body.method}`);
    }) as FetchLike;
    const protocolClient = new OfficialWalletMcpProtocolClient(
      'https://wallet.example/mcp',
      'test-bearer-token',
      { fetch: fetchMock }
    );

    await expect(protocolClient.callTool('get_client_profile')).resolves.toMatchObject({
      structuredContent: { profile: 'ready' },
    });
    expect(observedMethods).toContain('initialize');
    expect(observedMethods).toContain('tools/call');
    expect(observedAuthorizationHeaders.every(header => header === 'Bearer test-bearer-token')).toBe(true);

    await protocolClient.close();
  });

  it('delegates typed tool calls and preserves only bounded metadata', async () => {
    const protocolClient = createProtocolClient({
      callResult: {
        structuredContent: { accounts: [{ id: 'acc-1', name: 'Cash' }] },
        _meta: {
          rateLimit: {
            limit: 100,
            remaining: 42,
            resetAt: '2026-09-15T13:00:00Z',
            internalBucket: 'must-not-leak',
          },
          agentHints: [{
            type: 'wallet.sync_delayed',
            severity: 'warn',
            text: 'Data may still be syncing',
            internal: 'must-not-leak',
          }],
          arbitrarySecret: 'must-not-leak',
        },
      },
    });
    const client = new WalletMcpClientService('https://example.invalid', 'test-token', protocolClient);

    const result = await client.callMcpTool<{ accounts: unknown[] }>('get_accounts', { limit: 10 });

    expect(result.accounts).toHaveLength(1);
    expect(protocolClient.callTool).toHaveBeenCalledOnce();
    expect(protocolClient.callTool).toHaveBeenCalledWith('get_accounts', { limit: 10 });
    expect(client.getLastResponseMetadata('get_accounts')).toEqual({
      rateLimit: {
        limit: 100,
        remaining: 42,
        resetAt: '2026-09-15T13:00:00Z',
      },
      agentHints: [{
        type: 'wallet.sync_delayed',
        severity: 'warn',
        text: 'Data may still be syncing',
      }],
    });
  });

  it('normalizes tool discovery without invoking advertised tools', async () => {
    const protocolClient = createProtocolClient({
      tools: [{
        name: 'get_accounts',
        description: 'List accounts',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object' },
      }],
    });
    const client = new WalletMcpClientService('https://example.invalid', 'test-token', protocolClient);

    await expect(client.listTools()).resolves.toEqual([{
      name: 'get_accounts',
      description: 'List accounts',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
    }]);
    expect(protocolClient.callTool).not.toHaveBeenCalled();
  });

  it('maps authoritative tool errors to definitive failure', async () => {
    const protocolClient = createProtocolClient({
      callResult: {
        isError: true,
        content: [{ type: 'text', text: 'invalid account' }],
      },
    });
    const client = new WalletMcpClientService('https://example.invalid', 'test-token', protocolClient);

    const error = await captureRequestError(() => client.callMcpTool('create_records'));
    expect(error.dispatchOutcome).toBe('DEFINITIVE_FAILURE');
  });

  it('keeps timeouts and ambiguous HTTP failures unknown without retrying', async () => {
    const timeoutProtocolClient = createProtocolClient({
      callError: new SdkError(SdkErrorCode.RequestTimeout, 'request timed out'),
    });
    const timeoutClient = new WalletMcpClientService(
      'https://example.invalid',
      'test-token',
      timeoutProtocolClient
    );
    const timeoutError = await captureRequestError(() => timeoutClient.callMcpTool('create_records'));

    expect(timeoutError.dispatchOutcome).toBe('UNKNOWN');
    expect(timeoutProtocolClient.callTool).toHaveBeenCalledOnce();

    const unavailableProtocolClient = createProtocolClient({
      callError: new SdkHttpError(
        SdkErrorCode.ClientHttpFailedToOpenStream,
        'service unavailable',
        { status: 503 }
      ),
    });
    const unavailableClient = new WalletMcpClientService(
      'https://example.invalid',
      'test-token',
      unavailableProtocolClient
    );
    const unavailableError = await captureRequestError(
      () => unavailableClient.callMcpTool('create_records')
    );

    expect(unavailableError.dispatchOutcome).toBe('UNKNOWN');
    expect(unavailableProtocolClient.callTool).toHaveBeenCalledOnce();
  });

  it('maps explicit HTTP rejection to definitive failure and redacts credentials', async () => {
    const protocolClient = createProtocolClient({
      callError: new SdkHttpError(
        SdkErrorCode.ClientHttpFailedToOpenStream,
        'bad request Authorization: Bearer secret-token',
        { status: 400 }
      ),
    });
    const client = new WalletMcpClientService('https://example.invalid', 'secret-token', protocolClient);

    const error = await captureRequestError(() => client.callMcpTool('create_records'));

    expect(error.dispatchOutcome).toBe('DEFINITIVE_FAILURE');
    expect(error.message).not.toContain('secret-token');
    expect(error.message).toContain('[REDACTED_TOKEN]');
  });

  it('closes the protocol lifecycle through the Wallet adapter', async () => {
    const protocolClient = createProtocolClient();
    const client = new WalletMcpClientService('https://example.invalid', 'test-token', protocolClient);

    await client.close();

    expect(protocolClient.close).toHaveBeenCalledOnce();
  });
});
