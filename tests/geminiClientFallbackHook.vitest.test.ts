import { describe, expect, it, vi } from 'vitest';
import { executeGeminiGenerationWithFallback } from '../src/brain/providers/geminiClient.js';
import { ModelFallbackEvent } from '../src/brain/types.js';

describe('executeGeminiGenerationWithFallback hook behavior', () => {
  it('does not invoke onFallbackAttempt when the primary model succeeds immediately', async () => {
    const mockGenerateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify({ action: 'CREATE_RECORD' }),
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
    });

    const mockGoogleClient: any = {
      models: {
        generateContent: mockGenerateContent,
      },
    };

    const fallbackEvents: ModelFallbackEvent[] = [];

    const result = await executeGeminiGenerationWithFallback({
      googleGenAiClient: mockGoogleClient,
      candidateModelList: ['gemini-3.5-flash-lite', 'gemini-3.6-flash'],
      requestTimeoutMilliseconds: 5000,
      contents: [{ role: 'user', parts: [{ text: 'beli bakso 15rb' }] }],
      systemInstruction: 'Test instructions',
      requestContextDescription: 'Unit Test',
      onFallbackAttempt: async (event) => {
        fallbackEvents.push(event);
      },
    });

    expect(result.responseText).toContain('CREATE_RECORD');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(fallbackEvents).toHaveLength(0);
  });

  it('invokes onFallbackAttempt with correct details when primary model encounters 429', async () => {
    const rateLimitError: any = new Error('Resource has been exhausted (e.g. check quota)');
    rateLimitError.status = 429;

    const mockGenerateContent = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({
        text: JSON.stringify({ action: 'CREATE_RECORD' }),
      });

    const mockGoogleClient: any = {
      models: {
        generateContent: mockGenerateContent,
      },
    };

    const fallbackEvents: ModelFallbackEvent[] = [];

    const result = await executeGeminiGenerationWithFallback({
      googleGenAiClient: mockGoogleClient,
      candidateModelList: ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash'],
      requestTimeoutMilliseconds: 5000,
      contents: [{ role: 'user', parts: [{ text: 'kopi 20k' }] }],
      systemInstruction: 'Test instructions',
      requestContextDescription: 'Fallback Test',
      onFallbackAttempt: async (event) => {
        fallbackEvents.push(event);
      },
    });

    expect(result.responseText).toContain('CREATE_RECORD');
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]).toEqual({
      currentModel: 'gemini-3.5-flash-lite',
      nextModel: 'gemini-3.6-flash',
      attemptIndex: 1,
      totalCandidates: 3,
      reason: expect.any(String),
    });
  });

  it('continues smoothly without crashing if onFallbackAttempt callback throws', async () => {
    const mockGenerateContent = vi
      .fn()
      .mockRejectedValueOnce(new Error('Rate limit 429 exceeded'))
      .mockResolvedValueOnce({
        text: JSON.stringify({ action: 'GENERAL_REPLY' }),
      });

    const mockGoogleClient: any = {
      models: {
        generateContent: mockGenerateContent,
      },
    };

    const result = await executeGeminiGenerationWithFallback({
      googleGenAiClient: mockGoogleClient,
      candidateModelList: ['gemini-3.5-flash-lite', 'gemini-3.6-flash'],
      requestTimeoutMilliseconds: 5000,
      contents: [{ role: 'user', parts: [{ text: 'halo' }] }],
      systemInstruction: 'Test instructions',
      requestContextDescription: 'Error Tolerance Test',
      onFallbackAttempt: () => {
        throw new Error('Callback failed intentionally');
      },
    });

    expect(result.responseText).toContain('GENERAL_REPLY');
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });
});
