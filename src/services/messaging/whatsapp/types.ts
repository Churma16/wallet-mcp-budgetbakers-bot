import { WASocket } from '@whiskeysockets/baileys';

export interface WhatsappSafeguardConfiguration {
  maxReconnectAttempts?: number;
  maxBackoffSeconds?: number;
  messageQueueIntervalMs?: number;
  typingPresenceCooldownMs?: number;
  maxMediaDownloadBytes?: number;
}

export type WhatsappSocketProvider = () => WASocket | null;
