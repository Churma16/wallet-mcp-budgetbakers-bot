import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type ClientOptions,
  type FetchLike,
  type StreamableHTTPClientTransportOptions,
  type Transport,
} from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_DISCOVERED_WALLET_MCP_TOOLS,
  MAX_WALLET_MCP_AGENT_HINTS,
  WalletMcpClientService,
  WalletMcpRequestError,
} from '../src/services/walletMcpService.js';
import type {
  WalletMcpSdkClient,
  WalletMcpTransportDependencies,
} from '../src/services/walletMcpTransport.js';
import { WalletMcpTransport } from '../src/services/walletMcpTransport.js';

interface HarnessOptions {
  readonly callToolResult?: unknown;
  readonly callToolError?: unknown;
  readonly listToolsResult?: unknown;
  readonly listToolsError?: unknown;
}

function createHarness(options: HarnessOptions = {}) {
  const connect = vi.fn().mockResolvedValue(undefined);
  const callTool = options.callToolError === undefined
    ? vi.fn().mockResolvedValue(options.callToolResult ?? {
        content: [],
        structuredContent: { profile: 'ready' },
      })
    : vi.fn().mockRejectedValue(options.callToolError);
  const listTools = options.listToolsError === undefined
    ? vi.fn().mockResolvedValue(options.listToolsResult ?? { tools: [] })
    : vi.fn().mockRejectedValue(options.listToolsError);
  const close = vi.fn().mockResolvedValue(undefined);
  const client = { connect, callTool, listTools, close } as unknown as WalletMcpSdkClient;

  let clientOptions: ClientOptions | undefined;
  let transportEndpoint: URL | undefined;
  let transportOptions: StreamableHTTPClientTransportOptions | undefined;
  const transport = {} as Transport;
  const dependencies: WalletMcpTransportDependencies = {
    createClient: (_clientInfo, options) => {
      clientOptions = options;
      return client;
    },
    createTransport: (endpoint, options) => {
      transportEndpoint = endpoint;
      transportOptions = options;
      return transport;
    },
  };

  const service = new WalletMcpClientService(
    'https://wallet.example/mcp',
    'secret-wallet-token',
    dependencies
  );

  return {
    service,
    connect,
    callTool,
    listTools,
    close,
    getClientOptions: () => clientOptions,
    getTransportEndpoint: () => transportEndpoint,
    getTransportOptions: () => transportOptions,
  };
}

async function expectDispatchOutcome(
  operation: () => Promise<unknown>,
  expectedOutcome: WalletMcpRequestError['dispatchOutcome']
): Promise<WalletMcpRequestError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(WalletMcpRequestError);
    expect((error as WalletMcpRequestError).dispatchOutcome).toBe(expectedOutcome);
    return error as WalletMcpRequestError;
  }
  throw new Error('Expected Wallet MCP operation to fail');
}

describe('official MCP client boundary (issue #165)', () => {
  it('uses the official Streamable HTTP wire protocol with bearer authentication', async () => {
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
    const service = new WalletMcpClientService(
      'https://wallet.example/mcp',
      'test-bearer-token',
      {
        createTransport: (endpoint, options) => new StreamableHTTPClientTransport(
          endpoint,
          { ...options, fetch: fetchMock }
        ),
      }
    );

    await expect(service.verifyClientProfile()).resolves.toEqual({ profile: 'ready' });
    expect(observedMethods).toContain('server/discover');
    expect(observedMethods).toContain('initialize');
    expect(observedMethods).toContain('tools/call');
    expect(observedAuthorizationHeaders.every(header => header === 'Bearer test-bearer-token')).toBe(true);

    await service.close();
  });

  it('initializes the official client once with Streamable HTTP bearer auth and bounded retry policy', async () => {
    const harness = createHarness();

    await harness.service.verifyClientProfile();
    await harness.service.verifyClientProfile();

    expect(harness.connect).toHaveBeenCalledTimes(1);
    expect(harness.callTool).toHaveBeenCalledTimes(2);
    expect(harness.callTool).toHaveBeenCalledWith(
      { name: 'get_client_profile', arguments: {} },
      expect.objectContaining({ timeout: 15_000, maxTotalTimeout: 15_000, allowInputRequired: false })
    );
    expect(harness.getTransportEndpoint()?.href).toBe('https://wallet.example/mcp');
    const authProvider = harness.getTransportOptions()?.authProvider;
    expect(authProvider && 'token' in authProvider ? await authProvider.token() : undefined)
      .toBe('secret-wallet-token');
    expect(harness.getTransportOptions()?.reconnectionOptions?.maxRetries).toBe(0);
    expect(harness.getTransportOptions()?.maxStepUpRetries).toBe(0);
    expect(harness.getClientOptions()).toMatchObject({
      enforceStrictCapabilities: true,
      inputRequired: { autoFulfill: false },
      listMaxPages: 8,
      versionNegotiation: { mode: 'auto', probe: { timeoutMs: 15_000, maxRetries: 0 } },
    });

    await harness.service.close();
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it('normalizes bounded tool capabilities without granting advertised tools execution authority', async () => {
    const advertisedTools = Array.from({ length: MAX_DISCOVERED_WALLET_MCP_TOOLS + 2 }, (_, index) => ({
      name: index === 0 ? 'get_accounts' : `advertised_tool_${index}`,
      description: 'x'.repeat(1_200),
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
            enum: ['one', 'two'],
          },
        },
      },
      outputSchema: index === 0 ? { type: 'object' } : undefined,
    }));
    const harness = createHarness({ listToolsResult: { tools: advertisedTools } });

    const capabilities = await harness.service.listTools();

    expect(capabilities).toHaveLength(MAX_DISCOVERED_WALLET_MCP_TOOLS);
    expect(capabilities[0]).toMatchObject({
      name: 'get_accounts',
      isApplicationSupported: true,
      hasOutputSchema: true,
      inputSchema: {
        type: 'object',
        required: ['query'],
      },
      inputFields: [{ name: 'query', required: true, types: ['string'], enumValues: ['one', 'two'] }],
    });
    expect(capabilities[1].isApplicationSupported).toBe(false);
    expect(capabilities[0].description).toHaveLength(1_000);

    await expectDispatchOutcome(
      () => (harness.service as unknown as { callMcpTool(name: string): Promise<unknown> })
        .callMcpTool('advertised_tool_1'),
      'DEFINITIVE_FAILURE'
    );
    expect(harness.callTool).not.toHaveBeenCalled();
  });

  it('bounds primitive, invalid, and deeply nested advertised schema values', async () => {
    const harness = createHarness({
      listToolsResult: {
        tools: [{
          name: 'get_accounts',
          inputSchema: {
            type: 'object',
            nullable: null,
            enabled: true,
            count: 3,
            invalidNumber: Number.POSITIVE_INFINITY,
            values: [false, 7],
            nested: { a: { b: { c: { d: { e: { f: { omitted: 'too deep' } } } } } } },
          },
        }],
      },
    });

    const [capability] = await harness.service.listTools();

    expect(capability.inputSchema).toMatchObject({
      nullable: null,
      enabled: true,
      count: 3,
      values: [false, 7],
    });
    expect(capability.inputSchema).not.toHaveProperty('invalidNumber');
  });

  it('classifies list-tools failures without closing the client for request-level rejection', async () => {
    const harness = createHarness({
      listToolsError: new ProtocolError(-32602, 'invalid list request'),
    });

    await expectDispatchOutcome(() => harness.service.listTools(), 'DEFINITIVE_FAILURE');
    expect(harness.close).not.toHaveBeenCalled();
  });

  it('discards the shared client when list-tools reports a closed connection', async () => {
    const harness = createHarness({
      listToolsError: new SdkError(SdkErrorCode.ConnectionClosed, 'connection closed'),
    });

    await expectDispatchOutcome(() => harness.service.listTools(), 'UNKNOWN');
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it('retains only bounded rate-limit and agent-hint metadata', async () => {
    const agentHints = Array.from({ length: MAX_WALLET_MCP_AGENT_HINTS + 4 }, (_, index) => ({
      type: `hint.${index}`,
      severity: 'info',
      text: 'x'.repeat(700),
      data: { safe: index, nested: { secret: true } },
    }));
    const harness = createHarness({
      callToolResult: {
        content: [],
        structuredContent: { profile: 'ready' },
        _meta: {
          rateLimit: {
            limit: 100,
            remaining: 42,
            resetAt: '2026-09-15T13:00:00Z',
            retryAfterMs: 2500,
            arbitrarySecret: 'discard-me',
          },
          agentHints,
          arbitraryMetadata: { discard: true },
        },
      },
    });

    await harness.service.verifyClientProfile();
    const metadata = harness.service.getLastResponseMetadata('get_client_profile');

    expect(metadata?.rateLimit).toEqual({
      limit: 100,
      remaining: 42,
      resetAt: '2026-09-15T13:00:00Z',
      retryAfterMilliseconds: 2500,
    });
    expect(metadata?.agentHints).toHaveLength(MAX_WALLET_MCP_AGENT_HINTS);
    expect(metadata?.agentHints?.[0].text).toHaveLength(500);
    expect(metadata?.agentHints?.[0].data).toEqual({ safe: 0 });
    expect(metadata).not.toHaveProperty('arbitraryMetadata');
    expect(metadata?.rateLimit).not.toHaveProperty('arbitrarySecret');
  });

  it('ignores malformed agent hints and empty metadata', async () => {
    const harness = createHarness({
      callToolResult: {
        content: [],
        structuredContent: {
          profile: 'ready',
          agentHints: [null, {}, { type: '   ' }, { type: 'valid', data: [] }],
        },
        _meta: {
          rateLimit: { limit: -1, remaining: Number.NaN },
        },
      },
    });

    await harness.service.verifyClientProfile();
    expect(harness.service.getLastResponseMetadata('get_client_profile')).toEqual({
      agentHints: [{ type: 'valid', severity: undefined, text: undefined, data: undefined }],
      rateLimit: undefined,
    });
  });

  it.each([
    [{ content: [{ type: 'text', text: '{"profile":"ready"}' }] }, { profile: 'ready' }],
    [{ content: [{ type: 'text', text: 'plain response' }] }, 'plain response'],
    [{ content: [{ type: 'image', data: 'ignored', mimeType: 'image/png' }] }, {
      content: [{ type: 'image', data: 'ignored', mimeType: 'image/png' }],
    }],
  ])('normalizes tool content fallback %#', async (callToolResult, expected) => {
    const harness = createHarness({ callToolResult });
    await expect(harness.service.verifyClientProfile()).resolves.toEqual(expected);
  });

  it('maps authoritative protocol and tool rejections to definitive failure', async () => {
    const protocolHarness = createHarness({
      callToolError: new ProtocolError(-32602, 'invalid params secret-wallet-token'),
    });
    const protocolError = await expectDispatchOutcome(
      () => protocolHarness.service.createRecords([{ accountId: 'account-1', amount: -100 }]),
      'DEFINITIVE_FAILURE'
    );
    expect(protocolHarness.callTool).toHaveBeenCalledTimes(1);
    expect(protocolError.message).not.toContain('secret-wallet-token');

    const toolHarness = createHarness({
      callToolResult: {
        isError: true,
        content: [{ type: 'text', text: 'validation rejected' }],
      },
    });
    await expectDispatchOutcome(
      () => toolHarness.service.createRecords([{ accountId: 'account-1', amount: -100 }]),
      'DEFINITIVE_FAILURE'
    );
  });

  it('keeps a shared client alive when one concurrent request receives a protocol rejection', async () => {
    let resolvePendingCall: ((result: unknown) => void) | undefined;
    const pendingResult = new Promise(resolve => {
      resolvePendingCall = resolve;
    });
    const connect = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const callTool = vi.fn()
      .mockRejectedValueOnce(new ProtocolError(-32602, 'invalid params'))
      .mockReturnValueOnce(pendingResult);
    const client = {
      connect,
      callTool,
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      close,
    } as unknown as WalletMcpSdkClient;
    const service = new WalletMcpClientService(
      'https://wallet.example/mcp',
      'secret-wallet-token',
      {
        createClient: () => client,
        createTransport: () => ({} as Transport),
      }
    );

    const rejectedRequest = service.createRecords([{ accountId: 'account-1', amount: -100 }]);
    const pendingRequest = service.verifyClientProfile();

    await expectDispatchOutcome(() => rejectedRequest, 'DEFINITIVE_FAILURE');
    expect(close).not.toHaveBeenCalled();

    resolvePendingCall?.({ content: [], structuredContent: { profile: 'ready' } });
    await expect(pendingRequest).resolves.toEqual({ profile: 'ready' });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    await service.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    SdkErrorCode.NotConnected,
    SdkErrorCode.ConnectionClosed,
    SdkErrorCode.SendFailed,
  ])('discards an unusable shared client after SDK error %s', async code => {
    const harness = createHarness({
      callToolError: new SdkError(code, 'connection unavailable'),
    });

    await expect(harness.service.verifyClientProfile()).rejects.toBeInstanceOf(WalletMcpRequestError);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it('closes a client whose initial connection fails and preserves the connection error', async () => {
    const connectionError = new Error('connect failed');
    const close = vi.fn().mockRejectedValue(new Error('close failed'));
    const client = {
      connect: vi.fn().mockRejectedValue(connectionError),
      callTool: vi.fn(),
      listTools: vi.fn(),
      close,
    } as unknown as WalletMcpSdkClient;
    const transport = new WalletMcpTransport('https://wallet.example/mcp', 'token', {
      createClient: () => client,
      createTransport: () => ({} as Transport),
    });

    await expect(transport.callTool('get_accounts', {})).rejects.toBe(connectionError);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('waits for and closes a client that is still connecting', async () => {
    let resolveConnect: (() => void) | undefined;
    const connect = new Promise<void>(resolve => {
      resolveConnect = resolve;
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const client = {
      connect: vi.fn().mockReturnValue(connect),
      callTool: vi.fn().mockResolvedValue({ content: [], structuredContent: {} }),
      listTools: vi.fn(),
      close,
    } as unknown as WalletMcpSdkClient;
    const transport = new WalletMcpTransport('https://wallet.example/mcp', 'token', {
      createClient: () => client,
      createTransport: () => ({} as Transport),
    });

    const request = transport.callTool('get_accounts', {});
    const closing = transport.close();
    resolveConnect?.();

    await request;
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('maps ambiguous mutation transport failures to UNKNOWN without retrying', async () => {
    const harness = createHarness({
      callToolError: new SdkError(
        SdkErrorCode.RequestTimeout,
        'request timed out with secret-wallet-token'
      ),
    });

    const error = await expectDispatchOutcome(
      () => harness.service.createRecords([{ accountId: 'account-1', amount: -100 }]),
      'UNKNOWN'
    );

    expect(harness.callTool).toHaveBeenCalledTimes(1);
    expect(error.message).not.toContain('secret-wallet-token');
  });

  it.each([
    [400, 'DEFINITIVE_FAILURE'],
    [408, 'UNKNOWN'],
    [503, 'UNKNOWN'],
  ] as const)('classifies SDK HTTP %i as %s', async (status, expectedOutcome) => {
    const harness = createHarness({
      callToolError: new SdkHttpError(
        SdkErrorCode.ClientHttpUnexpectedContent,
        `HTTP ${status}`,
        { status }
      ),
    });

    await expectDispatchOutcome(
      () => harness.service.createRecords([{ accountId: 'account-1', amount: -100 }]),
      expectedOutcome
    );
    expect(harness.callTool).toHaveBeenCalledTimes(1);
  });
});
