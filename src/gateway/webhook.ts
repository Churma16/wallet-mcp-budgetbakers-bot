import http, { IncomingMessage, ServerResponse, Server } from 'node:http';
import crypto from 'node:crypto';
import { applicationLogger } from '../lib/logger.js';
import { isLoopbackHost } from '../config/environmentConfig.js';

export interface PushNotificationPayload {
  packageName: string;
  title: string;
  text: string;
  timestamp?: number;
  isTest?: boolean;
}

export interface NotificationWebhookResponse {
  success: boolean;
  message: string;
  ticketId?: number;
  correlationAction?: string;
}

export interface NotificationWebhookServerOptions {
  port: number;
  host: string;
  secret?: string;
  onNotificationReceived: (payload: PushNotificationPayload) => Promise<void>;
  maxPayloadBytes?: number;
  hardened?: boolean;
  allowUnauthenticated?: boolean;
}

/**
 * Constant-time string comparison using SHA-256 digests and crypto.timingSafeEqual.
 * Protects against timing attacks and length leaks without throwing RangeError.
 */
export function timingSafeCompare(actual: string, expected: string): boolean {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) {
    return false;
  }
  const actualHash = crypto.createHash('sha256').update(actual).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

/**
 * Lightweight HTTP server receiving incoming transaction push notifications from mobile forwarders.
 */
export class NotificationWebhookServer {
  private server: Server | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly secret: string;
  private readonly onNotificationReceived: (payload: PushNotificationPayload) => Promise<void>;
  private readonly maxPayloadBytes: number;
  private readonly hardened?: boolean;
  private readonly allowUnauthenticated?: boolean;
  private isListening = false;

  constructor(options: NotificationWebhookServerOptions) {
    this.port = options.port;
    this.host = options.host || '0.0.0.0';
    this.secret = (options.secret || '').trim();
    this.onNotificationReceived = options.onNotificationReceived;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 64 * 1024; // 64 KB default limit
    this.hardened = options.hardened;
    this.allowUnauthenticated = options.allowUnauthenticated;
  }

  public async start(): Promise<void> {
    if (this.isListening) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));

      this.server.on('error', error => {
        applicationLogger.error(`[NotificationWebhook] Server error: ${error.message}`);
        reject(error);
      });

      this.server.listen(this.port, this.host, () => {
        this.isListening = true;
        applicationLogger.success(
          `[NotificationWebhook] Webhook receiver listening on http://${this.host}:${this.port}`
        );
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.server || !this.isListening) {
      return;
    }

    return new Promise(resolve => {
      this.server?.close(() => {
        this.isListening = false;
        this.server = null;
        applicationLogger.info('[NotificationWebhook] Webhook receiver stopped.');
        resolve();
      });
    });
  }

  public getPort(): number {
    return this.port;
  }

  public isRunning(): boolean {
    return this.isListening;
  }

  public isHardenedMode(): boolean {
    if (this.hardened !== undefined) {
      return this.hardened;
    }
    if (this.allowUnauthenticated) {
      return false;
    }
    return !isLoopbackHost(this.host) || process.env.NODE_ENV === 'production';
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method?.toUpperCase();
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 1. Health check
    if (method === 'GET' && (pathname === '/health' || pathname === '/api/webhook/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    // 2. Notification webhook endpoint
    const isWebhookPath =
      pathname === '/api/webhook/notification' ||
      pathname === '/webhook/notification' ||
      pathname === '/api/notification';

    if (method === 'POST' && isWebhookPath) {
      this.handleNotificationIngestion(req, res);
      return;
    }

    // 404 for unknown endpoints
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }

  private handleNotificationIngestion(req: IncomingMessage, res: ServerResponse): void {
    // 1. Authenticate
    if (this.secret) {
      const rawAuthHeader = req.headers['authorization'];
      const authHeader = typeof rawAuthHeader === 'string'
        ? rawAuthHeader
        : Array.isArray(rawAuthHeader)
          ? rawAuthHeader[0] || ''
          : '';
      const expectedBearer = `Bearer ${this.secret}`;
      if (!timingSafeCompare(authHeader, expectedBearer)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Unauthorized: Invalid or missing Bearer token in Authorization header',
          })
        );
        return;
      }
    } else if (this.isHardenedMode()) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Unauthorized: Webhook secret is not configured and server is running in hardened mode',
        })
      );
      return;
    }

    // 2. Read request body with size bounds
    let bodyBuffer = '';
    let totalBytesReceived = 0;

    req.on('data', chunk => {
      totalBytesReceived += chunk.length;
      if (totalBytesReceived > this.maxPayloadBytes) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload Too Large' }));
        req.destroy();
        return;
      }
      bodyBuffer += chunk.toString('utf-8');
    });

    req.on('end', async () => {
      if (totalBytesReceived > this.maxPayloadBytes) {
        return;
      }

      let parsedPayload: Partial<PushNotificationPayload>;
      try {
        parsedPayload = JSON.parse(bodyBuffer) as Partial<PushNotificationPayload>;
      } catch (parseError: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Malformed JSON: ${parseError.message}` }));
        return;
      }

      if (!parsedPayload.packageName || (!parsedPayload.title && !parsedPayload.text)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Invalid payload: packageName and at least title or text are required',
          })
        );
        return;
      }

      const isTestPing =
        Boolean(parsedPayload.isTest) ||
        String(parsedPayload.packageName).trim() === 'codes.churma.walletforwarder';

      const validPayload: PushNotificationPayload = {
        packageName: String(parsedPayload.packageName).trim(),
        title: String(parsedPayload.title || '').trim(),
        text: String(parsedPayload.text || '').trim(),
        timestamp: typeof parsedPayload.timestamp === 'number' ? parsedPayload.timestamp : Date.now(),
        isTest: isTestPing,
      };

      // Delegate to handler
      try {
        await this.onNotificationReceived(validPayload);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            message: isTestPing
              ? 'Test ping received and verified'
              : 'Notification received and processed',
          })
        );
      } catch (handlerError: any) {
        applicationLogger.error(
          `[NotificationWebhook] Handler execution error: ${handlerError.message}`
        );
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error processing notification' }));
      }
    });

    req.on('error', err => {
      applicationLogger.error(`[NotificationWebhook] Error reading request body: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error processing payload' }));
      }
    });
  }
}
