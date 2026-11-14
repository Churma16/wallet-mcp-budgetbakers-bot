import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import {
  NotificationWebhookServer,
  PushNotificationPayload,
  timingSafeCompare,
} from '../src/gateway/webhook.js';
import { isLoopbackHost } from '../src/config/environmentConfig.js';

describe('timingSafeCompare', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeCompare('Bearer secret123', 'Bearer secret123')).toBe(true);
  });

  it('returns false for mismatched strings of identical length', () => {
    expect(timingSafeCompare('Bearer secret123', 'Bearer secret124')).toBe(false);
  });

  it('returns false for mismatched strings of different lengths without throwing', () => {
    expect(timingSafeCompare('Bearer short', 'Bearer very-long-secret-token-value')).toBe(false);
    expect(timingSafeCompare('Bearer very-long-secret-token-value', 'Bearer short')).toBe(false);
  });

  it('returns false when actual or expected is empty or not a string', () => {
    expect(timingSafeCompare('', 'Bearer secret')).toBe(false);
    expect(timingSafeCompare('Bearer secret', '')).toBe(false);
    expect(timingSafeCompare('', '')).toBe(false);
    expect(timingSafeCompare(null as any, 'Bearer secret')).toBe(false);
    expect(timingSafeCompare('Bearer secret', undefined as any)).toBe(false);
  });
});

describe('isLoopbackHost', () => {
  it('identifies loopback hosts correctly', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('127.0.1.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(isLoopbackHost('  127.0.0.1  ')).toBe(true);
  });

  it('identifies non-loopback hosts correctly', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
    expect(isLoopbackHost('api.example.com')).toBe(false);
    expect(isLoopbackHost('127.example.com')).toBe(false);
    expect(isLoopbackHost('127.corp.internal')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe('NotificationWebhookServer', () => {
  let server: NotificationWebhookServer;
  const testPort = 39999;
  const testSecret = 'secret-test-token-12345';
  let receivedPayloads: PushNotificationPayload[] = [];

  beforeEach(() => {
    receivedPayloads = [];
  });

  afterEach(async () => {
    if (server && server.isRunning()) {
      await server.stop();
    }
  });

  function makeRequest(
    method: string,
    path: string,
    body?: any,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const payloadString = body ? JSON.stringify(body) : undefined;
      const reqHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Connection: 'close',
        ...headers,
      };
      if (payloadString) {
        reqHeaders['Content-Length'] = Buffer.byteLength(payloadString).toString();
      }

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: testPort,
          path,
          method,
          headers: reqHeaders,
        },
        res => {
          let resData = '';
          res.on('data', chunk => {
            resData += chunk;
          });
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode || 0,
                body: resData ? JSON.parse(resData) : null,
              });
            } catch {
              resolve({
                status: res.statusCode || 0,
                body: resData,
              });
            }
          });
        }
      );

      req.on('error', reject);
      if (payloadString) {
        req.write(payloadString);
      }
      req.end();
    });
  }

  it('starts and stops gracefully and handles health check', async () => {
    server = new NotificationWebhookServer({
      port: testPort,
      host: '127.0.0.1',
      secret: testSecret,
      onNotificationReceived: async payload => {
        receivedPayloads.push(payload);
      },
    });

    expect(server.isRunning()).toBe(false);
    await server.start();
    expect(server.isRunning()).toBe(true);

    const health = await makeRequest('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');

    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it('rejects unauthorized requests when secret is configured', async () => {
    server = new NotificationWebhookServer({
      port: testPort,
      host: '127.0.0.1',
      secret: testSecret,
      onNotificationReceived: async payload => {
        receivedPayloads.push(payload);
      },
    });
    await server.start();

    // No auth header
    const noAuth = await makeRequest('POST', '/api/webhook/notification', {
      packageName: 'com.jago',
      title: 'Transfer',
      text: 'Rp 10.000',
    });
    expect(noAuth.status).toBe(401);
    expect(receivedPayloads.length).toBe(0);

    // Wrong token
    const wrongAuth = await makeRequest(
      'POST',
      '/api/webhook/notification',
      { packageName: 'com.jago', title: 'Transfer', text: 'Rp 10.000' },
      { Authorization: 'Bearer wrong-secret' }
    );
    expect(wrongAuth.status).toBe(401);
    expect(receivedPayloads.length).toBe(0);
  });

  it('accepts authorized requests and triggers callback', async () => {
    server = new NotificationWebhookServer({
      port: testPort,
      host: '127.0.0.1',
      secret: testSecret,
      onNotificationReceived: async payload => {
        receivedPayloads.push(payload);
      },
    });
    await server.start();

    const response = await makeRequest(
      'POST',
      '/api/webhook/notification',
      {
        packageName: 'com.jago',
        title: 'Transaksi Berhasil',
        text: 'Pembayaran Rp 15.799 berhasil',
        timestamp: 1730335000000,
      },
      { Authorization: `Bearer ${testSecret}` }
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Notification received and processed');
    expect(receivedPayloads.length).toBe(1);
    expect(receivedPayloads[0].packageName).toBe('com.jago');
    expect(receivedPayloads[0].text).toBe('Pembayaran Rp 15.799 berhasil');
  });

  it('accepts test ping payload and returns verified ping message', async () => {
    server = new NotificationWebhookServer({
      port: testPort,
      host: '127.0.0.1',
      secret: testSecret,
      onNotificationReceived: async payload => {
        receivedPayloads.push(payload);
      },
    });
    await server.start();

    const response = await makeRequest(
      'POST',
      '/api/webhook/notification',
      {
        packageName: 'codes.churma.walletforwarder',
        title: 'Test Ping (Wallet Forwarder)',
        text: 'Connectivity check',
        isTest: true,
      },
      { Authorization: `Bearer ${testSecret}` }
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.message).toBe('Test ping received and verified');
    expect(receivedPayloads.length).toBe(1);
    expect(receivedPayloads[0].isTest).toBe(true);
    expect(receivedPayloads[0].packageName).toBe('codes.churma.walletforwarder');
  });

  it('validates required payload properties', async () => {
    server = new NotificationWebhookServer({
      port: testPort,
      host: '127.0.0.1',
      secret: testSecret,
      onNotificationReceived: async payload => {
        receivedPayloads.push(payload);
      },
    });
    await server.start();

    const missingFields = await makeRequest(
      'POST',
      '/api/webhook/notification',
      { packageName: '' },
      { Authorization: `Bearer ${testSecret}` }
    );
    expect(missingFields.status).toBe(400);
    expect(missingFields.body.error).toContain('packageName');
  });

  it('returns 404 for unknown endpoints', async () => {
    server = new NotificationWebhookServer({
      port: testPort,
      host: '127.0.0.1',
      onNotificationReceived: async () => {},
    });
    await server.start();

    const notFound = await makeRequest('GET', '/unknown-route');
    expect(notFound.status).toBe(404);
  });

  it('rejects oversized payloads with 413 Payload Too Large', async () => {
    server = new NotificationWebhookServer({
      port: testPort,
      host: '127.0.0.1',
      maxPayloadBytes: 50, // very small limit for testing
      onNotificationReceived: async () => {},
    });
    await server.start();

    const largeData = {
      packageName: 'com.jago',
      title: 'This is a very long title that exceeds fifty bytes easily',
      text: 'And lots more content to push it well beyond limits',
    };

    const response = await makeRequest('POST', '/api/webhook/notification', largeData);
    expect([413, 0]).toContain(response.status);
  });

  it('returns 500 when handler callback throws an unexpected error', async () => {
    server = new NotificationWebhookServer({
      port: testPort,
      host: '127.0.0.1',
      onNotificationReceived: async () => {
        throw new Error('Database connection failed');
      },
    });
    await server.start();

    const response = await makeRequest('POST', '/webhook/notification', {
      packageName: 'com.jago',
      title: 'Valid title',
      text: 'Valid text',
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain('Internal server error');
  });

  it('rejects unauthorized requests with constant-time verification when token length differs', async () => {
    server = new NotificationWebhookServer({
      port: testPort,
      host: '127.0.0.1',
      secret: testSecret,
      onNotificationReceived: async payload => {
        receivedPayloads.push(payload);
      },
    });
    await server.start();

    // Mismatched token of different length
    const shortTokenResponse = await makeRequest(
      'POST',
      '/api/webhook/notification',
      { packageName: 'com.jago', title: 'Transfer', text: 'Rp 10.000' },
      { Authorization: 'Bearer s' }
    );
    expect(shortTokenResponse.status).toBe(401);
    expect(shortTokenResponse.body.error).toContain('Unauthorized');
    expect(receivedPayloads.length).toBe(0);

    // Basic auth instead of Bearer
    const basicAuthResponse = await makeRequest(
      'POST',
      '/api/webhook/notification',
      { packageName: 'com.jago', title: 'Transfer', text: 'Rp 10.000' },
      { Authorization: `Basic ${testSecret}` }
    );
    expect(basicAuthResponse.status).toBe(401);
    expect(receivedPayloads.length).toBe(0);
  });

  it('fails closed and rejects requests when secret is blank in hardened mode', async () => {
    server = new NotificationWebhookServer({
      port: testPort,
      host: '127.0.0.1',
      hardened: true,
      onNotificationReceived: async payload => {
        receivedPayloads.push(payload);
      },
    });
    expect(server.isHardenedMode()).toBe(true);
    await server.start();

    const response = await makeRequest('POST', '/api/webhook/notification', {
      packageName: 'com.jago',
      title: 'Transfer',
      text: 'Rp 10.000',
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toContain('hardened mode');
    expect(receivedPayloads.length).toBe(0);
  });

  it('fails closed when host is 0.0.0.0 (non-loopback) without a secret', async () => {
    server = new NotificationWebhookServer({
      port: testPort,
      host: '0.0.0.0',
      onNotificationReceived: async payload => {
        receivedPayloads.push(payload);
      },
    });
    expect(server.isHardenedMode()).toBe(true);
    await server.start();

    const response = await makeRequest('POST', '/api/webhook/notification', {
      packageName: 'com.jago',
      title: 'Transfer',
      text: 'Rp 10.000',
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toContain('hardened mode');
    expect(receivedPayloads.length).toBe(0);
  });

  it('fails closed when NODE_ENV is production even on loopback host without a secret', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      server = new NotificationWebhookServer({
        port: testPort,
        host: '127.0.0.1',
        onNotificationReceived: async payload => {
          receivedPayloads.push(payload);
        },
      });
      expect(server.isHardenedMode()).toBe(true);
      await server.start();

      const response = await makeRequest('POST', '/api/webhook/notification', {
        packageName: 'com.jago',
        title: 'Transfer',
        text: 'Rp 10.000',
      });

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('hardened mode');
      expect(receivedPayloads.length).toBe(0);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('allows unauthenticated requests on loopback when allowUnauthenticated is explicitly set', async () => {
    server = new NotificationWebhookServer({
      port: testPort,
      host: '127.0.0.1',
      allowUnauthenticated: true,
      onNotificationReceived: async payload => {
        receivedPayloads.push(payload);
      },
    });
    expect(server.isHardenedMode()).toBe(false);
    await server.start();

    const response = await makeRequest('POST', '/api/webhook/notification', {
      packageName: 'com.jago',
      title: 'Dev Ping',
      text: 'Dev notification',
    });

    expect(response.status).toBe(200);
    expect(receivedPayloads.length).toBe(1);
  });
});
