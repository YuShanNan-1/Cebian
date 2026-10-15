import { describe, it, expect, vi } from 'vitest';
import { Type } from 'typebox';
import { applyFetchedSelection, supportsToolCalling, toModel } from '@/lib/providers/custom-models';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { CHAT_PROVIDER_MAX_RETRIES, withProviderRetries } from '@/lib/agent/provider-retry';
import type { CustomModelDef, CustomProviderConfig } from '@/lib/persistence/storage';

const configured: CustomModelDef = {
  modelId: 'gpt-x',
  name: 'gpt-x',
  reasoning: true,
  image: true,
  contextWindow: 200000,
  maxTokens: 4096,
};

describe('applyFetchedSelection', () => {
  const fresh = (modelId: string): CustomModelDef => ({ modelId, name: modelId, reasoning: false, image: false });
  const manual: CustomModelDef = { modelId: 'manual-only', name: 'manual-only', reasoning: true, image: false };

  it('首次获取（列表为空）：只加入勾选的，以默认值补入，顺序跟随远端', () => {
    expect(applyFetchedSelection([], ['a', 'b', 'c'], new Set(['c', 'a']))).toEqual([fresh('a'), fresh('c')]);
  });

  it('首次获取一个都没勾 → 仍为空', () => {
    expect(applyFetchedSelection([], ['a', 'b'], new Set())).toEqual([]);
  });

  it('勾选的既有模型保留原配置（含「不支持工具调用」）', () => {
    const chatOnly: CustomModelDef = { ...configured, toolCalling: false };
    expect(applyFetchedSelection([chatOnly], ['gpt-x'], new Set(['gpt-x']))).toEqual([chatOnly]);
  });

  it('远端有但没勾的既有模型被移除', () => {
    expect(applyFetchedSelection([configured, fresh('b')], ['gpt-x', 'b'], new Set(['b']))).toEqual([fresh('b')]);
  });

  it('不在远端列表里的手动模型原样保留，哪怕什么都没勾', () => {
    expect(applyFetchedSelection([manual, configured], ['gpt-x'], new Set())).toEqual([manual]);
  });

  it('既有模型保持原顺序，新模型按远端顺序追加在后', () => {
    expect(
      applyFetchedSelection([fresh('z'), manual, configured], ['new2', 'gpt-x', 'z', 'new1'], new Set(['gpt-x', 'z', 'new1', 'new2'])),
    ).toEqual([fresh('z'), manual, configured, fresh('new2'), fresh('new1')]);
  });

  it('远端重复 id 只补入一次', () => {
    expect(applyFetchedSelection([], ['a', 'a'], new Set(['a']))).toEqual([fresh('a')]);
  });

  it('勾选集里不在远端列表的 id 被忽略', () => {
    expect(applyFetchedSelection([], ['a'], new Set(['a', 'ghost']))).toEqual([fresh('a')]);
  });
});

describe('toModel', () => {
  const cfg: CustomProviderConfig = { id: 'p', name: 'P', baseUrl: 'https://x/v1', models: [] };
  const m: CustomModelDef = { modelId: 'm', name: 'm', reasoning: false };

  it('旧配置与显式 Chat Completions 配置使用同一接口', () => {
    expect(toModel(cfg, m).api).toBe('openai-completions');
    expect(toModel({ ...cfg, api: 'openai-completions' }, m)).toEqual(toModel(cfg, m));
  });

  it('Responses 保留模型设置，不携带 Chat Completions 的兼容参数', () => {
    const model = toModel({ ...cfg, api: 'openai-responses' }, configured);
    expect(model.api).toBe('openai-responses');
    expect(model.compat).toBeUndefined();
    expect(model).toMatchObject({
      id: configured.modelId,
      provider: 'custom:p',
      baseUrl: cfg.baseUrl,
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: configured.contextWindow,
      maxTokens: configured.maxTokens,
    });
  });

  it('Responses 保留自定义请求头与关闭工具调用的设置', () => {
    const headers = { 'X-A': '1' };
    const model = toModel({ ...cfg, api: 'openai-responses', headers }, { ...m, toolCalling: false });
    expect(model.headers).toEqual(headers);
    expect(supportsToolCalling(model)).toBe(false);
  });

  it('默认禁用 developer 角色并用 max_tokens 字段，避免第三方端点不兼容 (#46 #57 #54)', () => {
    const expected = { supportsDeveloperRole: false, maxTokensField: 'max_tokens' };
    expect(toModel(cfg, m).compat).toEqual(expected);
    expect(toModel(cfg, { ...m, reasoning: true }).compat).toEqual(expected);
  });

  it('provider 有 headers → 并入 model.headers', () => {
    expect(toModel({ ...cfg, headers: { 'X-A': '1' } }, m).headers).toEqual({ 'X-A': '1' });
  });

  it('无 headers / 空 headers → model 不带 headers', () => {
    expect(toModel(cfg, m).headers).toBeUndefined();
    expect(toModel({ ...cfg, headers: {} }, m).headers).toBeUndefined();
  });

  it('Responses 请求走正确路径，临时失败后重试并解析流式文字与工具调用', async () => {
    const message = {
      id: 'msg_1', type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
    };
    const toolCall = {
      id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"query":"test"}',
    };
    const events = [
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'Hello' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.output_item.added', output_index: 1, item: { ...toolCall, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: toolCall.arguments },
      { type: 'response.output_item.done', output_index: 1, item: toolCall },
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [message, toolCall] } },
    ];
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"error":{"message":"Temporary failure"}}', {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '0.001' },
      }))
      .mockResolvedValueOnce(new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    const onRetry = vi.fn();
    const onSettled = vi.fn();
    const stream = withProviderRetries(streamSimple, { onRetry, onSettled })(toModel({ ...cfg, api: 'openai-responses', headers: { 'X-Test': 'kept' } }, m), {
      messages: [{ role: 'user', content: 'test', timestamp: 0 }],
      tools: [{ name: 'lookup', description: 'Look up a query', parameters: Type.Object({ query: Type.String() }) }],
    }, {
      apiKey: 'test-key',
      maxTokens: 128,
      fetch: fetchMock,
    });
    const eventTypes = [];
    for await (const event of stream) eventTypes.push(event.type);
    const result = await stream.result();

    expect(result.stopReason).toBe('toolUse');
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: 'Hello' }),
      expect.objectContaining({ type: 'toolCall', name: 'lookup', arguments: { query: 'test' } }),
    ]);
    expect(eventTypes).toContain('text_delta');
    expect(eventTypes).toContain('toolcall_delta');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, maxAttempts: CHAT_PROVIDER_MAX_RETRIES, phase: 'waiting' }));
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, maxAttempts: CHAT_PROVIDER_MAX_RETRIES, phase: 'requesting' });
    expect(onSettled).toHaveBeenCalledOnce();
    const request = new Request(...fetchMock.mock.calls[1]);
    expect(request.url).toBe('https://x/v1/responses');
    expect(request.headers.get('X-Test')).toBe('kept');
    expect(request.headers.get('Authorization')).toBe('Bearer test-key');
    const payload = await request.json();
    expect(payload).toMatchObject({
      model: m.modelId, stream: true, store: false, max_output_tokens: 128,
      tools: [expect.objectContaining({ type: 'function', name: 'lookup' })],
    });
    expect(payload.input).toEqual(expect.any(Array));
    expect(payload).not.toHaveProperty('messages');
    expect(payload).not.toHaveProperty('max_tokens');
  });

  it('Responses 请求被停止后不再重试', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    const onRetry = vi.fn();
    const stream = withProviderRetries(streamSimple, { onRetry, onSettled: vi.fn() })(toModel({ ...cfg, api: 'openai-responses' }, m), {
      messages: [{ role: 'user', content: 'test', timestamp: 0 }],
    }, {
      apiKey: 'test-key',
      signal: controller.signal,
      fetch: fetchMock,
    });

    expect((await stream.result()).stopReason).toBe('aborted');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('supportsToolCalling', () => {
  const cfg: CustomProviderConfig = { id: 'p', name: 'P', baseUrl: 'https://x/v1', models: [] };
  const m: CustomModelDef = { modelId: 'm', name: 'm', reasoning: false };

  it('自定义模型缺省 / 显式开启都支持工具调用', () => {
    expect(supportsToolCalling(toModel(cfg, m))).toBe(true);
    expect(supportsToolCalling(toModel(cfg, { ...m, toolCalling: true }))).toBe(true);
  });

  it('关闭后不支持，且标记在展开复制后仍保留', () => {
    const model = toModel(cfg, { ...m, toolCalling: false });
    expect(supportsToolCalling(model)).toBe(false);
    expect(supportsToolCalling({ ...model })).toBe(false);
  });

  it('内置模型一律支持', () => {
    const builtin = getBuiltinModels('anthropic');
    expect(builtin.length).toBeGreaterThan(0);
    expect(builtin.every(supportsToolCalling)).toBe(true);
  });
});
