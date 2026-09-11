import { applicationLogger } from '../../../utils/logger.js';

interface OutboundQueueItem {
  task: () => Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export class WhatsappOutboundMessageQueue {
  private readonly queue: OutboundQueueItem[] = [];
  private isProcessing = false;
  private isStopped = false;

  constructor(
    private readonly intervalMilliseconds: number,
    private readonly isConnected: () => boolean
  ) {}

  public get length(): number {
    return this.queue.length;
  }

  public enqueue(task: () => Promise<void>): Promise<void> {
    if (this.isStopped || !this.isConnected()) {
      return Promise.reject(new Error('[error] WhatsApp socket is not connected'));
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      void this.process().catch(queueError => {
        applicationLogger.error(`Error during outbound queue processing: ${queueError}`);
      });
    });
  }

  public resume(): void {
    this.isStopped = false;
  }

  public stop(): void {
    this.isStopped = true;
    while (this.queue.length > 0) {
      this.queue.shift()?.reject(
        new Error('[error] WhatsApp adapter was stopped, message dispatch cancelled.')
      );
    }
  }

  private async process(): Promise<void> {
    if (this.isProcessing) {
      return;
    }
    this.isProcessing = true;

    try {
      while (!this.isStopped && this.queue.length > 0) {
        const queueItem = this.queue.shift();
        if (!queueItem) {
          continue;
        }

        if (!this.isConnected()) {
          queueItem.reject(new Error('[error] WhatsApp socket is not connected'));
          continue;
        }

        try {
          await queueItem.task();
          queueItem.resolve();
        } catch (executionError: unknown) {
          queueItem.reject(executionError);
        }

        if (this.queue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, this.intervalMilliseconds));
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}
