import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { CHAT_PROVIDER_MAX_RETRIES, withProviderRetries } from './provider-retry';

const model: Model<Api> = {
  id: 'test', name: 'Test', api: 'openai-completions', provider: 'openai',
  baseUrl: 'https://example.invalid/v1', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000, maxTokens: 1_000,
};
const context = { messages: [{ role: 'user' as const, content: 'hello', timestamp: 0 }] };
const codexModel: Model<Api> = {
  ...model, api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api',
};
const codexToken = `header.${btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }))}.signature`;

function success(): Response {
  const chunks = [
    { id: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
    { id: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function run(fetchImpl: typeof fetch, options: SimpleStreamOptions = {}) {
  const callbacks = { onRetry: vi.fn(), onSettled: vi.fn() };
  const stream = withProviderRetries(streamSimple, callbacks)(model, context, {
    apiKey: 'test-key', ...options, fetch: fetchImpl,
  });
  return { ...callbacks, stream, result: stream.result() };
}

describe('聊天请求重试', () => {
  beforeAll(async () => {
    // 先加载真实适配器，后续用假时钟验证等待，不把模块加载耗时算进去。
    await run(async () => success()).result;
    await streamSimple(codexModel, context, {
      apiKey: codexToken, transport: 'sse', maxRetries: 0,
      fetch: async () => new Response('Unauthorized', { status: 401 }),
    }).result();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('首次请求加五次重试，间隔严格为 2、5、10、10、10 秒', async () => {
    const startedAt = Date.now();
    const times: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      times.push(Date.now() - startedAt);
      return new Response('Temporary failure', { status: 502 });
    });
    const { result, onRetry, onSettled } = run(fetchImpl);

    await vi.runAllTimersAsync();

    expect((await result).stopReason).toBe('error');
    expect(CHAT_PROVIDER_MAX_RETRIES).toBe(5);
    expect(times).toEqual([0, 2_000, 7_000, 17_000, 27_000, 37_000]);
    expect(onRetry.mock.calls.map(([status]) => [status.attempt, status.phase])).toEqual([
      [1, 'waiting'], [1, 'requesting'], [2, 'waiting'], [2, 'requesting'],
      [3, 'waiting'], [3, 'requesting'], [4, 'waiting'], [4, 'requesting'],
      [5, 'waiting'], [5, 'requesting'],
    ]);
    expect(onRetry.mock.calls.every(([status]) => status.maxAttempts === 5)).toBe(true);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it.each([408, 409, 429, 500, 502, 503, 504])('HTTP %s 会重试，成功后清除状态', async status => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Temporary failure', { status }))
      .mockImplementation(async () => success());
    const { result, onRetry, onSettled } = run(fetchImpl);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1, maxAttempts: 5, phase: 'waiting', retryAt: Date.now() + 1,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect((await result).content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 402, 403, 404, 413, 422])('HTTP %s 不重试', async status => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('Rejected', { status }));
    const { result, onRetry } = run(fetchImpl);
    expect((await result).stopReason).toBe('error');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it.each(['insufficient_quota', 'insufficient_balance', 'context_length_exceeded', 'model_not_found'])('%s 即使返回临时状态码也不重试', async code => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { code, message: code } }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    }));
    const { result, onRetry } = run(fetchImpl);
    expect((await result).stopReason).toBe('error');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('服务器明确禁止重试时直接失败', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('Rejected', {
      status: 503, headers: { 'x-should-retry': 'false' },
    }));
    const { result, onRetry } = run(fetchImpl);
    expect((await result).stopReason).toBe('error');
    expect(onRetry).not.toHaveBeenCalled();
  });

  it.each([
    ['usage_limit_reached', 1],
    ['rate_limit_exceeded', CHAT_PROVIDER_MAX_RETRIES + 1],
  ])('Codex 按原始 %s 区分额度用尽和临时限流', async (code, requests) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      error: { code, message: code, resets_at: Math.floor(Date.now() / 1_000) + 3_600 },
    }), { status: 429, headers: { 'Content-Type': 'application/json' } }));
    const callbacks = { onRetry: vi.fn(), onSettled: vi.fn() };
    const stream = withProviderRetries(streamSimple, callbacks)(codexModel, context, {
      apiKey: codexToken, transport: 'sse', fetch: fetchImpl,
    });
    await vi.runAllTimersAsync();

    expect((await stream.result()).stopReason).toBe('error');
    expect(fetchImpl).toHaveBeenCalledTimes(requests);
    expect(callbacks.onRetry).toHaveBeenCalledTimes((requests - 1) * 2);
  });

  it('网络失败按同一间隔重试', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementation(async () => success());
    const { result } = run(fetchImpl);
    await vi.runAllTimersAsync();
    expect((await result).stopReason).toBe('stop');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('每次 SDK 超时后仍可重试，等待不占用下一次请求的超时', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true });
    })).mockImplementation(async () => success());
    const { result, onRetry } = run(fetchImpl, { timeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ phase: 'waiting', attempt: 1 }));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect((await result).stopReason).toBe('stop');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ 'Retry-After': '8' }, 8_000],
    [{ 'retry-after-ms': '7500' }, 7_500],
    [{ 'Retry-After': 'Thu, 15 Oct 2026 00:00:09 GMT' }, 9_000],
    [{ 'Retry-After': '0.001' }, 2_000],
    [{ 'Retry-After': 'invalid' }, 2_000],
  ])('遵守服务器等待提示 %j', async (headers, delay) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Busy', { status: 429, headers: headers as HeadersInit }))
      .mockImplementation(async () => success());
    const { result } = run(fetchImpl);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).stopReason).toBe('stop');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('保留服务器等待上限，超出时说明原因', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('Busy', {
      status: 429, headers: { 'Retry-After': '61' },
    }));
    const { result, onRetry } = run(fetchImpl);
    expect((await result).errorMessage).toContain('61s retry delay (max: 60s)');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('等待期间停止，立即取消计时并清除状态', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('Busy', { status: 503 }));
    const { result, onRetry, onSettled } = run(fetchImpl, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(onRetry).toHaveBeenCalledOnce();
    controller.abort();

    expect((await result).stopReason).toBe('aborted');
    await vi.runAllTimersAsync();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('重试请求进行中停止，不再发后续请求', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Busy', { status: 503 }))
      .mockImplementation((_input, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }));
    const { result, onSettled } = run(fetchImpl, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    controller.abort();
    expect((await result).stopReason).toBe('aborted');
    await vi.runAllTimersAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it('已经开始输出后的断流不重跑请求', async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new TypeError('Connection lost')); } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const { result, onRetry } = run(fetchImpl);
    expect((await result).stopReason).toBe('error');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('同步异常也会结束回复，不让界面一直等待', async () => {
    const source = vi.fn<typeof streamSimple>().mockImplementation(() => { throw new Error('Invalid configuration'); });
    const callbacks = { onRetry: vi.fn(), onSettled: vi.fn() };
    const stream = withProviderRetries(source, callbacks)(model, context);
    expect((await stream.result()).errorMessage).toBe('Invalid configuration');
    expect(callbacks.onRetry).not.toHaveBeenCalled();
  });
});
