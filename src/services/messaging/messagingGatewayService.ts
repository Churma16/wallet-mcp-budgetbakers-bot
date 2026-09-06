import { applicationLogger } from '../../utils/logger.js';
import {
  MessagingAdapter,
  SupportedMessengerChannel,
} from './types.js';

export class MessagingGatewayService {
  private readonly adapterMap: Map<SupportedMessengerChannel, MessagingAdapter> = new Map();

  public registerAdapter(adapter: MessagingAdapter): void {
    if (this.adapterMap.has(adapter.channelName)) {
      applicationLogger.warn(`Overwriting existing adapter for channel: ${adapter.channelName}`);
    }
    this.adapterMap.set(adapter.channelName, adapter);
    applicationLogger.info(`Registered messaging adapter: [${adapter.channelName.toUpperCase()}]`);
  }

  public getAdapter(channel: SupportedMessengerChannel): MessagingAdapter | undefined {
    return this.adapterMap.get(channel);
  }

  public getActiveChannels(): SupportedMessengerChannel[] {
    return Array.from(this.adapterMap.keys());
  }

  public async startAll(): Promise<void> {
    const channelList = this.getActiveChannels();
    if (channelList.length === 0) {
      throw new Error('[error] No messaging adapters registered to start.');
    }

    applicationLogger.info(`Starting messaging gateway with ${channelList.length} channel(s): [${channelList.join(', ').toUpperCase()}]`);

    const startupPromises = Array.from(this.adapterMap.values()).map(async adapter => {
      try {
        await adapter.startConnection();
      } catch (startError: unknown) {
        applicationLogger.error(`Failed to initialize [${adapter.channelName.toUpperCase()}] adapter: ${startError}`);
        throw startError;
      }
    });

    await Promise.all(startupPromises);
  }

  public async stopAll(): Promise<void> {
    const shutdownPromises = Array.from(this.adapterMap.values()).map(async adapter => {
      if (adapter.stopConnection) {
        try {
          await adapter.stopConnection();
        } catch (stopError: unknown) {
          applicationLogger.warn(`Error stopping adapter [${adapter.channelName}]: ${stopError}`);
        }
      }
    });

    await Promise.all(shutdownPromises);
  }

  public async sendMessage(
    channel: SupportedMessengerChannel,
    targetChatIdentifier: string,
    messageText: string
  ): Promise<void> {
    const adapter = this.adapterMap.get(channel);
    if (!adapter) {
      throw new Error(`[error] Cannot send message: adapter for channel '${channel}' is not registered.`);
    }

    await adapter.sendTextMessage(targetChatIdentifier, messageText);
  }

  public async sendTypingPresence(
    channel: SupportedMessengerChannel,
    targetChatIdentifier: string
  ): Promise<void> {
    const adapter = this.adapterMap.get(channel);
    if (adapter) {
      await adapter.sendTypingPresence(targetChatIdentifier);
    }
  }

  public async clearTypingPresence(
    channel: SupportedMessengerChannel,
    targetChatIdentifier: string
  ): Promise<void> {
    const adapter = this.adapterMap.get(channel);
    if (adapter) {
      await adapter.clearTypingPresence(targetChatIdentifier);
    }
  }

  /**
   * Broadcasts a notification message (e.g. email transaction prompt) to all active channels
   */
  public async broadcastNotification(messageText: string): Promise<void> {
    const activeAdapters = Array.from(this.adapterMap.values());
    if (activeAdapters.length === 0) {
      applicationLogger.warn('Cannot broadcast notification: no messaging adapters are active.');
      return;
    }

    const broadcastPromises = activeAdapters.map(async adapter => {
      try {
        await adapter.sendBroadcastNotification(messageText);
        applicationLogger.success(`Dispatched broadcast notification to [${adapter.channelName.toUpperCase()}].`);
      } catch (broadcastError: unknown) {
        applicationLogger.error(
          `Failed to broadcast notification to [${adapter.channelName.toUpperCase()}]: ${broadcastError}`
        );
      }
    });

    await Promise.all(broadcastPromises);
  }
}
