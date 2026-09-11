import readline from 'node:readline';
import { applicationLogger } from '../../utils/logger.js';
import {
  AdapterConnectionState,
  MessagingAdapter,
  SupportedMessengerChannel,
  UserMessageCallback,
} from './types.js';

export interface ConsoleAdapterConfiguration {
  readonly inputStream?: NodeJS.ReadableStream;
  readonly outputStream?: NodeJS.WritableStream;
  readonly promptPrefix?: string;
  readonly senderIdentifier?: string;
  readonly chatIdentifier?: string;
  readonly onExitRequested?: () => void | Promise<void>;
}

export class ConsoleMessagingAdapter implements MessagingAdapter {
  public readonly channelName: SupportedMessengerChannel = 'console';
  private readlineInterface: readline.Interface | null = null;
  private isRunning: boolean = false;
  private isProcessingMessage: boolean = false;

  private readonly inputStream: NodeJS.ReadableStream;
  private readonly outputStream: NodeJS.WritableStream;
  private readonly promptPrefix: string;
  private readonly senderIdentifier: string;
  private readonly chatIdentifier: string;
  private readonly onExitRequested?: () => void | Promise<void>;

  constructor(
    private readonly onUserMessageReceived: UserMessageCallback,
    adapterConfiguration?: ConsoleAdapterConfiguration
  ) {
    this.inputStream = adapterConfiguration?.inputStream ?? process.stdin;
    this.outputStream = adapterConfiguration?.outputStream ?? process.stdout;
    this.promptPrefix = adapterConfiguration?.promptPrefix ?? '> ';
    this.senderIdentifier = adapterConfiguration?.senderIdentifier ?? 'console_user';
    this.chatIdentifier = adapterConfiguration?.chatIdentifier ?? 'console';
    this.onExitRequested = adapterConfiguration?.onExitRequested;
  }

  public getConnectionState(): AdapterConnectionState {
    return this.isRunning ? 'connected' : 'idle';
  }

  public getSenderIdentifier(): string {
    return this.senderIdentifier;
  }

  public getChatIdentifier(): string {
    return this.chatIdentifier;
  }

  public async startConnection(): Promise<void> {
    if (this.isRunning) {
      await this.stopConnection();
    }

    this.readlineInterface = readline.createInterface({
      input: this.inputStream,
      output: this.outputStream,
      prompt: this.promptPrefix,
    });

    this.isRunning = true;

    this.outputStream.write(
      '\n[INFO] Console messaging adapter active. Type your message and press Enter (type \'exit\' or \'quit\' to exit).\n\n'
    );

    this.readlineInterface.on('line', async (rawLine: string) => {
      const trimmedLine = rawLine.trim();

      if (!trimmedLine) {
        if (this.isRunning && this.readlineInterface) {
          this.readlineInterface.prompt();
        }
        return;
      }

      if (trimmedLine.toLowerCase() === 'exit' || trimmedLine.toLowerCase() === 'quit') {
        this.outputStream.write('\n[INFO] Exiting console session...\n');
        await this.stopConnection();
        if (this.onExitRequested) {
          await this.onExitRequested();
        }
        return;
      }

      this.isProcessingMessage = true;
      try {
        await this.onUserMessageReceived({
          channel: 'console',
          senderIdentifier: this.senderIdentifier,
          chatIdentifier: this.chatIdentifier,
          messageType: 'text',
          textPayload: trimmedLine,
        });
      } catch (messageProcessingError: unknown) {
        const errorDetail =
          messageProcessingError instanceof Error
            ? messageProcessingError.message
            : String(messageProcessingError);
        applicationLogger.error(`[ERROR] Failed to process console message: ${errorDetail}`);
        this.outputStream.write(
          `\n[ERROR] An error occurred while processing your message: ${errorDetail}\n\n`
        );
      } finally {
        this.isProcessingMessage = false;
        if (this.isRunning && this.readlineInterface) {
          this.readlineInterface.prompt();
        }
      }
    });

    this.readlineInterface.on('close', () => {
      if (this.isRunning) {
        this.isRunning = false;
        if (this.onExitRequested) {
          void this.onExitRequested();
        }
      }
    });

    this.readlineInterface.on('SIGINT', () => {
      this.outputStream.write('\n[INFO] Console session interrupted.\n');
      void this.stopConnection().then(async () => {
        if (this.onExitRequested) {
          await this.onExitRequested();
        } else {
          process.exit(0);
        }
      });
    });

    this.readlineInterface.prompt();
  }

  public async stopConnection(): Promise<void> {
    this.isRunning = false;
    if (this.readlineInterface) {
      this.readlineInterface.removeAllListeners();
      this.readlineInterface.close();
      this.readlineInterface = null;
    }
  }

  public async sendTextMessage(_targetChatIdentifier: string, messageText: string): Promise<void> {
    this.outputStream.write(`\n${messageText}\n\n`);
    if (this.isRunning && this.readlineInterface && !this.isProcessingMessage) {
      this.readlineInterface.prompt();
    }
  }

  public async sendTypingPresence(_targetChatIdentifier: string): Promise<void> {
    // Keep terminal clean without intrusive typing updates
  }

  public async clearTypingPresence(_targetChatIdentifier: string): Promise<void> {
    // Keep terminal clean
  }

  public async sendBroadcastNotification(messageText: string): Promise<void> {
    await this.sendTextMessage(this.chatIdentifier, messageText);
  }
}
