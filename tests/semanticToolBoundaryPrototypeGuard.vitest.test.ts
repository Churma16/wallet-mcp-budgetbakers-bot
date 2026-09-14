import { describe, expect, it } from 'vitest';
import { SemanticToolBoundary } from '../src/services/ai/semanticToolBoundary.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';

const event: IncomingUserMessageEvent = {
  channel: 'console',
  senderIdentifier: 'console_user',
  chatIdentifier: 'console',
  messageType: 'text',
  textPayload: 'test',
};

describe('SemanticToolBoundary prototype-name guard', () => {
  it.each(['toString', 'constructor', '__proto__'])('rejects inherited object property name %s as an unknown tool', tool => {
    const decision = new SemanticToolBoundary().evaluate({
      proposal: { tool, arguments: {} },
      authorization: { isAuthorized: true, source: 'test-policy' },
      event,
      availableAccountList: [],
      availableCategoryList: [],
    });

    expect(decision).toMatchObject({
      accepted: false,
      code: 'UNKNOWN_TOOL',
    });
  });
});
