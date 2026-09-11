import { strict as assert } from 'node:assert';
import { WhatsappMessagingAdapter } from '../src/services/messaging/whatsappAdapter.js';
import { MessageIdTracker } from '../src/services/messaging/whatsapp/messageIdTracker.js';
import { WhatsappOutboundMessageQueue } from '../src/services/messaging/whatsapp/outboundMessageQueue.js';

async function run(): Promise<void> {
  const tracker = new MessageIdTracker(2);
  tracker.record('first');
  tracker.record('second');
  tracker.record('third');
  assert.equal(tracker.has('first'), false, 'tracker evicts its oldest identifier');
  assert.equal(tracker.has('third'), true, 'tracker retains recent identifiers');

  const dispatchOrder: string[] = [];
  const queue = new WhatsappOutboundMessageQueue(0, () => true);
  await Promise.all([
    queue.enqueue(async () => { dispatchOrder.push('first'); }),
    queue.enqueue(async () => { dispatchOrder.push('second'); }),
  ]);
  assert.deepEqual(dispatchOrder, ['first', 'second'], 'outbound queue remains FIFO');

  const receivedTexts: string[] = [];
  const adapter = new WhatsappMessagingAdapter('./test_auth_session', '6281234567890', async event => {
    if (event.textPayload) receivedTexts.push(event.textPayload);
  }, { messageQueueIntervalMs: 0 });

  (adapter as any).socketInstance = {
    user: { id: '6281234567890:1@s.whatsapp.net' },
    sendMessage: async (
      _jid: string,
      content: { text: string },
      options: { messageId: string }
    ) => {
      await adapter.processIncomingMessages([{
        key: { remoteJid: '6281234567890@s.whatsapp.net', id: options.messageId, fromMe: true },
        message: { conversation: content.text },
      }]);
      return { key: { id: options.messageId } };
    },
  };

  await adapter.sendTextMessage('6281234567890@s.whatsapp.net', 'arbitrary bot response');
  assert.deepEqual(receivedTexts, [], 'pre-registered outgoing identifiers prevent pre-resolution bot loops');

  await adapter.processIncomingMessages([{
    key: { remoteJid: '6281234567890@s.whatsapp.net', id: 'manual-self-message', fromMe: true },
    message: { conversation: '⚠️ manually entered command-like text' },
  }]);
  assert.deepEqual(
    receivedTexts,
    ['⚠️ manually entered command-like text'],
    'human-facing prefixes are not used to classify bot-authored messages'
  );

  console.log('[SUCCESS] WhatsApp component boundaries and identifier-based loop prevention passed.');
}

run().catch(error => {
  console.error(`[ERROR] WhatsApp component boundary test failed: ${error}`);
  process.exit(1);
});
