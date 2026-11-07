import { describe, expect, it, vi } from 'vitest';
import { getDictionary } from '../src/i18n/index.js';
import { GeminiAiProvider } from '../src/brain/providers/geminiProvider.js';
import { OpenAiCompatibleAiProvider } from '../src/brain/providers/openAiProvider.js';
import { FallbackAiProvider } from '../src/brain/providers/fallbackProvider.js';
import { ModelFallbackProgressTracker } from '../src/core/modelFallbackProgressTracker.js';
import { MessagingGatewayService } from '../src/gateway/coordinator.js';
import { RuntimeSettingsManager } from '../src/config/index.js';

describe('Fallback Status and Provider Model Coverage', () => {
  it('covers i18n fallback status strings in ID and EN locales', () => {
    const idDict = getDictionary('id');
    const enDict = getDictionary('en');

    expect(idDict.aiFallbackStatus.initial('gemini-3.5-flash')).toContain('gemini-3.5-flash');
    expect(idDict.aiFallbackStatus.initial()).toContain('transaksi Anda');
    expect(idDict.aiFallbackStatus.cycling('gemini-3.6-flash')).toContain('gemini-3.6-flash');

    expect(enDict.aiFallbackStatus.initial('gemini-3.5-flash')).toContain('gemini-3.5-flash');
    expect(enDict.aiFallbackStatus.initial()).toContain('Processing your transaction');
    expect(enDict.aiFallbackStatus.cycling('gemini-3.6-flash')).toContain('gemini-3.6-flash');
  });

  it('covers getPrimaryModel across Gemini, OpenAI, and Fallback providers', () => {
    vi.spyOn(RuntimeSettingsManager.getInstance(), 'getStoredOverrides').mockReturnValue({});

    const gemini = new GeminiAiProvider('dummy-key', 'gemini-custom-primary', ['gemini-custom-fallback']);
    expect(gemini.getPrimaryModel()).toBe('gemini-custom-primary');

    const openAi = new OpenAiCompatibleAiProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'dummy-key',
      primaryModelName: 'gpt-4o-mini',
      providerName: 'openai',
    });
    expect(openAi.getPrimaryModel()).toBe('gpt-4o-mini');

    const fallbackWithMethods = new FallbackAiProvider([gemini, openAi]);
    expect(fallbackWithMethods.getPrimaryModel()).toBe('gemini-custom-primary');

    const dummyProviderNoMethod: any = {
      providerName: 'mock-no-method',
      processTextMessage: vi.fn(),
      processImageMessage: vi.fn(),
      processEmailTransactionMessage: vi.fn(),
    };
    const fallbackWithoutMethod = new FallbackAiProvider([dummyProviderNoMethod]);
    expect(fallbackWithoutMethod.getPrimaryModel()).toBe('mock-no-method');
  });

  it('covers plain string literal options in ModelFallbackProgressTracker', async () => {
    const mockGateway: any = {
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'msg-plain' }),
      editMessage: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
      sendTypingPresence: vi.fn().mockResolvedValue(undefined),
    };

    const tracker = new ModelFallbackProgressTracker({
      gateway: mockGateway as MessagingGatewayService,
      channel: 'telegram',
      chatIdentifier: '123456',
      initialMessage: 'Plain literal initial message',
      cyclingMessage: 'Plain literal cycling message',
      gracePeriodMs: 100,
    });

    vi.useFakeTimers();
    try {
      tracker.start();
      await vi.advanceTimersByTimeAsync(101);

      expect(mockGateway.sendMessage).toHaveBeenCalledWith(
        'telegram',
        '123456',
        'Plain literal initial message'
      );

      await tracker.handleFallback({
        currentModel: 'm1',
        nextModel: 'm2',
        attemptIndex: 1,
        totalCandidates: 2,
      });

      expect(mockGateway.editMessage).toHaveBeenCalledWith(
        'telegram',
        '123456',
        'msg-plain',
        'Plain literal cycling message'
      );

      await tracker.cleanup();
      expect(mockGateway.deleteMessage).toHaveBeenCalledWith('telegram', '123456', 'msg-plain');
    } finally {
      vi.useRealTimers();
    }
  });
});
