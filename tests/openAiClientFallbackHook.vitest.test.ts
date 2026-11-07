import { describe, expect, it, vi } from 'vitest';
import { executeChatCompletionWithFallback } from '../src/brain/providers/openAiClient.js';
import { ModelFallbackEvent } from '../src/brain/types.js';

describe('executeChatCompletionWithFallback hook behavior', () => {
  it('does not invoke onFallbackAttempt when the primary model succeeds immediately', async () => {
    const mockPost = vi.fn().mockResolvedValue({
      data: {
        choices: [{ message: { content: JSON.stringify({ action: 'CREATE_RECORD' }) } }],
        usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
      },
    });

    const mockHttpClient: any = { post: mockPost };
    const fallbackEvents: ModelFallbackEvent[] = [];

    const result = await executeChatCompletionWithFallback(
      mockHttpClient,
      ['meta-llama/llama-3.3-70b-instruct', 'qwen/qwen-2.5-72b-instruct'],
      'openrouter',
      5000,
      [{ role: 'user', content: 'beli kopi 25rb' }],
      'Test Context',
      true,
      async (event) => {
        fallbackEvents.push(event);
      }
    );

    expect(result.responseText).toContain('CREATE_RECORD');
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(fallbackEvents).toHaveLength(0);
  });

  it('invokes onFallbackAttempt with model names when primary candidate fails with 429', async () => {
    const rateLimitError: any = new Error('Rate limit exceeded (429)');
    rateLimitError.response = { status: 429, data: { error: { message: 'Too many requests' } } };

    const mockPost = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: JSON.stringify({ action: 'CREATE_RECORD' }) } }],
        },
      });

    const mockHttpClient: any = { post: mockPost };
    const fallbackEvents: ModelFallbackEvent[] = [];

    const result = await executeChatCompletionWithFallback(
      mockHttpClient,
      ['meta-llama/llama-3.3-70b-instruct', 'qwen/qwen-2.5-72b-instruct', 'anthropic/claude-3.5-haiku'],
      'openrouter',
      5000,
      [{ role: 'user', content: 'makan 50k' }],
      'OpenRouter Fallback Test',
      true,
      async (event) => {
        fallbackEvents.push(event);
      }
    );

    expect(result.responseText).toContain('CREATE_RECORD');
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]).toEqual({
      currentModel: 'meta-llama/llama-3.3-70b-instruct',
      nextModel: 'qwen/qwen-2.5-72b-instruct',
      attemptIndex: 1,
      totalCandidates: 3,
      reason: expect.any(String),
    });
  });

  it('continues fallback execution even if onFallbackAttempt callback throws', async () => {
    const mockPost = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('503 Service Unavailable'), { response: { status: 503 } }))
      .mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: JSON.stringify({ action: 'GENERAL_REPLY' }) } }],
        },
      });

    const mockHttpClient: any = { post: mockPost };

    const result = await executeChatCompletionWithFallback(
      mockHttpClient,
      ['model-primary', 'model-fallback'],
      'openai-compatible',
      5000,
      [{ role: 'user', content: 'halo' }],
      'Error Handling Test',
      true,
      () => {
        throw new Error('Callback failed');
      }
    );

    expect(result.responseText).toContain('GENERAL_REPLY');
    expect(mockPost).toHaveBeenCalledTimes(2);
  });
});
