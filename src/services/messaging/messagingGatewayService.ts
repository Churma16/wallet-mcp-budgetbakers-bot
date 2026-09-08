import { applicationLogger } from '../../utils/logger.js';
import {
  AdapterConnectionState,
  MessagingAdapter,
  SupportedMessengerChannel,
} from './types.js';

export interface MessagingGatewayConfiguration {
  maxBackgroundReconnectAttempts?: number;
  backgroundReconnectBaseDelayMs?: number;
  backgroundReconnectMaxDelayMs?: number;
}

export class MessagingGatewayService {
  private readonly adapterMap: Map<SupportedMessengerChannel, MessagingAdapter> = new Map();
  private readonly adapterStateMap: Map<SupportedMessengerChannel, AdapterConnectionState> = new Map();
  private readonly activeReconnectTimers: Map<SupportedMessengerChannel, NodeJS.Timeout> = new Map();
  private readonly reconnectAttemptCounters: Map<SupportedMessengerChannel, number> = new Map();

  private readonly maxBackgroundReconnectAttempts: number;
  private readonly backgroundReconnectBaseDelayMs: number;
  private readonly backgroundReconnectMaxDelayMs: number;

  constructor(gatewayConfiguration?: MessagingGatewayConfiguration) {
    this.maxBackgroundReconnectAttempts = gatewayConfiguration?.maxBackgroundReconnectAttempts ?? 10;
    this.backgroundReconnectBaseDelayMs = gatewayConfiguration?.backgroundReconnectBaseDelayMs ?? 5000;
    this.backgroundReconnectMaxDelayMs = gatewayConfiguration?.backgroundReconnectMaxDelayMs ?? 60000;
  }

  public registerAdapter(adapter: MessagingAdapter): void {
    if (this.adapterMap.has(adapter.channelName)) {
      applicationLogger.warn(`Overwriting existing adapter for channel: ${adapter.channelName}`);
    }
    this.adapterMap.set(adapter.channelName, adapter);
    this.adapterStateMap.set(adapter.channelName, 'idle');
    applicationLogger.info(`Registered messaging adapter: [${adapter.channelName.toUpperCase()}]`);
  }

  public getAdapter(channel: SupportedMessengerChannel): MessagingAdapter | undefined {
    return this.adapterMap.get(channel);
  }

  public getAdapterState(channel: SupportedMessengerChannel): AdapterConnectionState {
    return this.adapterStateMap.get(channel) ?? 'idle';
  }

  public isChannelConnected(channel: SupportedMessengerChannel): boolean {
    return this.getAdapterState(channel) === 'connected';
  }

  public getActiveChannels(): SupportedMessengerChannel[] {
    return Array.from(this.adapterMap.keys());
  }

  public getConnectedChannels(): SupportedMessengerChannel[] {
    return Array.from(this.adapterMap.keys()).filter(channel => this.isChannelConnected(channel));
  }

  public getReconnectingChannels(): SupportedMessengerChannel[] {
    return Array.from(this.adapterMap.keys()).filter(channel => this.getAdapterState(channel) === 'reconnecting');
  }

  public getFailedChannels(): SupportedMessengerChannel[] {
    return Array.from(this.adapterMap.keys()).filter(channel => this.getAdapterState(channel) === 'failed');
  }

  public hasActiveReconnectTimer(channel: SupportedMessengerChannel): boolean {
    return this.activeReconnectTimers.has(channel);
  }

  public getMaxBackgroundReconnectAttempts(): number {
    return this.maxBackgroundReconnectAttempts;
  }

  public getBackgroundReconnectBaseDelayMs(): number {
    return this.backgroundReconnectBaseDelayMs;
  }

  public getBackgroundReconnectMaxDelayMs(): number {
    return this.backgroundReconnectMaxDelayMs;
  }

  public calculateReconnectDelay(attemptIndex: number): number {
    const exponentialDelay = this.backgroundReconnectBaseDelayMs * Math.pow(2, attemptIndex);
    const boundedDelay = Math.min(this.backgroundReconnectMaxDelayMs, exponentialDelay);
    const maximumJitter = Math.min(2000, this.backgroundReconnectBaseDelayMs);
    const minimumJitter = Math.min(500, Math.floor(this.backgroundReconnectBaseDelayMs / 4));
    const jitterRange = Math.max(1, maximumJitter - minimumJitter);
    const randomJitterMilliseconds = Math.floor(Math.random() * jitterRange) + minimumJitter;
    return boundedDelay + randomJitterMilliseconds;
  }


  public async startAll(): Promise<void> {
    const channelList = this.getActiveChannels();
    if (channelList.length === 0) {
      throw new Error('[error] No messaging adapters registered to start.');
    }

    applicationLogger.info(
      `Starting messaging gateway with ${channelList.length} channel(s): [${channelList.join(', ').toUpperCase()}]`
    );

    const startupResults = await Promise.allSettled(
      channelList.map(async channel => {
        const adapter = this.adapterMap.get(channel)!;
        try {
          this.adapterStateMap.set(channel, 'reconnecting');
          await adapter.startConnection();
          this.adapterStateMap.set(channel, 'connected');
          this.reconnectAttemptCounters.delete(channel);
          applicationLogger.success(
            `[SUCCESS] Messaging adapter [${channel.toUpperCase()}] started successfully.`
          );
          return channel;
        } catch (startError: unknown) {
          this.adapterStateMap.set(channel, 'failed');
          applicationLogger.error(
            `Failed to initialize [${channel.toUpperCase()}] adapter: ${startError}`
          );
          throw startError;
        }
      })
    );

    const connectedChannels: SupportedMessengerChannel[] = [];
    const failedChannels: SupportedMessengerChannel[] = [];

    for (let channelIndex = 0; channelIndex < startupResults.length; channelIndex++) {
      const channel = channelList[channelIndex];
      const result = startupResults[channelIndex];
      if (result.status === 'fulfilled') {
        connectedChannels.push(channel);
      } else {
        failedChannels.push(channel);
      }
    }

    if (connectedChannels.length === 0) {
      applicationLogger.error('All registered messaging adapters failed to initialize.');
      throw new Error('[error] All registered messaging adapters failed to initialize.');
    }

    if (failedChannels.length > 0) {
      applicationLogger.warn(
        `[WARN] Messaging gateway running in degraded mode. Connected: [${connectedChannels.join(', ').toUpperCase()}], Failed: [${failedChannels.join(', ').toUpperCase()}]. Initiating background reconnection for failed channel(s)...`
      );
      for (const failedChannel of failedChannels) {
        this.scheduleBackgroundReconnect(failedChannel);
      }
    } else {
      applicationLogger.success(
        `[SUCCESS] All ${connectedChannels.length} messaging adapter(s) connected: [${connectedChannels.join(', ').toUpperCase()}].`
      );
    }
  }

  public scheduleBackgroundReconnect(channel: SupportedMessengerChannel): void {
    if (this.activeReconnectTimers.has(channel)) {
      return;
    }

    const adapter = this.adapterMap.get(channel);
    if (!adapter) {
      return;
    }

    const currentAttempt = this.reconnectAttemptCounters.get(channel) ?? 0;
    if (currentAttempt >= this.maxBackgroundReconnectAttempts) {
      this.adapterStateMap.set(channel, 'failed');
      applicationLogger.error(
        `[ERROR] Background reconnection exhausted (${this.maxBackgroundReconnectAttempts} attempts) for [${channel.toUpperCase()}]. Channel marked as permanently failed.`
      );
      return;
    }

    const delayMilliseconds = this.calculateReconnectDelay(currentAttempt);
    this.adapterStateMap.set(channel, 'reconnecting');
    applicationLogger.info(
      `[INFO] Scheduling background reconnection for [${channel.toUpperCase()}] in ${(delayMilliseconds / 1000).toFixed(1)}s (Attempt ${currentAttempt + 1}/${this.maxBackgroundReconnectAttempts})...`
    );

    const reconnectTimer = setTimeout(async () => {
      this.activeReconnectTimers.delete(channel);
      applicationLogger.info(`[INFO] Executing background reconnection attempt for [${channel.toUpperCase()}]...`);

      try {
        await adapter.startConnection();
        this.adapterStateMap.set(channel, 'connected');
        this.reconnectAttemptCounters.delete(channel);
        applicationLogger.success(
          `[SUCCESS] Background reconnection succeeded for [${channel.toUpperCase()}]. Channel is now active!`
        );
      } catch (reconnectError: unknown) {
        applicationLogger.warn(
          `[WARN] Background reconnection attempt ${currentAttempt + 1} failed for [${channel.toUpperCase()}]: ${reconnectError}`
        );
        this.reconnectAttemptCounters.set(channel, currentAttempt + 1);
        this.scheduleBackgroundReconnect(channel);
      }
    }, delayMilliseconds);

    this.activeReconnectTimers.set(channel, reconnectTimer);
  }

  public async stopAll(): Promise<void> {
    for (const [channel, timer] of this.activeReconnectTimers.entries()) {
      clearTimeout(timer);
      applicationLogger.info(`[INFO] Cancelled background reconnection timer for [${channel.toUpperCase()}].`);
    }
    this.activeReconnectTimers.clear();
    this.reconnectAttemptCounters.clear();

    const shutdownPromises = Array.from(this.adapterMap.entries()).map(async ([channel, adapter]) => {
      this.adapterStateMap.set(channel, 'idle');
      if (adapter.stopConnection) {
        try {
          await adapter.stopConnection();
        } catch (stopError: unknown) {
          applicationLogger.warn(`[WARN] Error stopping adapter [${channel.toUpperCase()}]: ${stopError}`);
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

    const channelState = this.getAdapterState(channel);
    if (channelState !== 'connected') {
      applicationLogger.warn(
        `[WARN] Cannot send message via [${channel.toUpperCase()}]: channel is currently '${channelState}'.`
      );
      throw new Error(
        `[error] Cannot send message: channel '${channel}' is not connected (current state: ${channelState}).`
      );
    }

    await adapter.sendTextMessage(targetChatIdentifier, messageText);
  }

  public async sendTypingPresence(
    channel: SupportedMessengerChannel,
    targetChatIdentifier: string
  ): Promise<void> {
    if (this.isChannelConnected(channel)) {
      const adapter = this.adapterMap.get(channel);
      if (adapter) {
        await adapter.sendTypingPresence(targetChatIdentifier);
      }
    }
  }

  public async clearTypingPresence(
    channel: SupportedMessengerChannel,
    targetChatIdentifier: string
  ): Promise<void> {
    if (this.isChannelConnected(channel)) {
      const adapter = this.adapterMap.get(channel);
      if (adapter) {
        await adapter.clearTypingPresence(targetChatIdentifier);
      }
    }
  }

  /**
   * Broadcasts a notification message (e.g. email transaction prompt) to all connected channels
   */
  public async broadcastNotification(messageText: string): Promise<void> {
    const connectedAdapters = Array.from(this.adapterMap.entries())
      .filter(([channel]) => this.isChannelConnected(channel))
      .map(([, adapter]) => adapter);

    if (connectedAdapters.length === 0) {
      applicationLogger.warn('[WARN] Cannot broadcast notification: no messaging adapters are currently connected.');
      return;
    }

    const broadcastPromises = connectedAdapters.map(async adapter => {
      try {
        await adapter.sendBroadcastNotification(messageText);
        applicationLogger.success(
          `[SUCCESS] Dispatched broadcast notification to [${adapter.channelName.toUpperCase()}].`
        );
      } catch (broadcastError: unknown) {
        applicationLogger.error(
          `[ERROR] Failed to broadcast notification to [${adapter.channelName.toUpperCase()}]: ${broadcastError}`
        );
      }
    });

    await Promise.allSettled(broadcastPromises);
  }
}

