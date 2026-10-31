import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { NotificationWebhookServer } from '../src/services/webhook/notificationWebhookServer.js';
import { PushNotificationPayload } from '../src/services/webhook/types.js';

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
    expect(receivedPayloads.length).toBe(1);
    expect(receivedPayloads[0].packageName).toBe('com.jago');
    expect(receivedPayloads[0].text).toBe('Pembayaran Rp 15.799 berhasil');
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
});
