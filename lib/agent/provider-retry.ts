import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from '@earendil-works/pi-ai';
import type { streamSimple } from '@earendil-works/pi-ai/compat';

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 10_000, 10_000] as const;
const CHAT_PROVIDER_MAX_RETRIES = RETRY_DELAYS_MS.length;
const NON_RETRYABLE_ERROR = /insufficient_quota|insufficient[_ ](?:balance|credits)|billing_hard_limit_reached|credit balance|usage_limit_reached|context_length_exceeded|maximum context length|model_not_found|invalid_api_key/iu;

interface ProviderRetryStatus {
  attempt: number;
  maxAttempts: number;
  phase: 'waiting' | 'requesting';
  retryAt?: number;
}

function isRetryableProviderStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryDelayMs(headers: Headers | undefined, attempt: number, maxDelayMs = 60_000): number {
  let serverDelay = Number.parseFloat(headers?.get('retry-after-ms') ?? '');
  if (!Number.isFinite(serverDelay)) {
    const retryAfter = headers?.get('retry-after') ?? '';
    const seconds = Number.parseFloat(retryAfter);
    serverDelay = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1_000;
  }
  if (Number.isFinite(serverDelay) && maxDelayMs > 0 && serverDelay > maxDelayMs) {
    throw new Error(`Server requested ${Math.ceil(serverDelay / 1_000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1_000)}s).`);
  }
  return Math.max(RETRY_DELAYS_MS[attempt], Number.isFinite(serverDelay) ? serverDelay : 0);
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withProviderRetries(
  streamFn: typeof streamSimple,
  callbacks: {
    onRetry: (status: ProviderRetryStatus) => void;
    onSettled: () => void;
  },
): typeof streamSimple {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    const fetchImpl = options?.fetch ?? globalThis.fetch.bind(globalThis);
    let attempt = 0;
    let retrying = false;
    let lastMessage: AssistantMessage | undefined;

    void (async () => {
      try {
        for (;;) {
          options?.signal?.throwIfAborted();
          let retryable = false;
          let headers: Headers | undefined;
          let started = false;
          let retry = false;
          const source = streamFn(model, context, {
            ...options,
            // 每次请求只由这里重试，等待在 SDK 请求外进行，不占用下一次请求的超时。
            maxRetries: 0,
            fetch: async (input, init) => {
              try {
                const response = await fetchImpl(input, init);
                headers = response.headers;
                retryable = isRetryableProviderStatus(response.status)
                  && headers.get('x-should-retry') !== 'false';
                if (retryable) {
                  // 部分适配器会把额度用尽和临时限流改成同一句话，先保留原始错误的判断。
                  retryable = !NON_RETRYABLE_ERROR.test(await response.clone().text());
                }
                return response;
              } catch (error) {
                retryable = !options?.signal?.aborted;
                throw error;
              }
            },
          });

          for await (const event of source) {
            lastMessage = event.type === 'error' ? event.error
              : event.type === 'done' ? event.message : event.partial;
            if (event.type === 'error' && !started && retryable
              && event.reason !== 'aborted' && !options?.signal?.aborted
              && attempt < CHAT_PROVIDER_MAX_RETRIES
              && !NON_RETRYABLE_ERROR.test(event.error.errorMessage ?? '')) {
              const delay = retryDelayMs(headers, attempt, options?.maxRetryDelayMs);
              attempt++;
              retrying = true;
              callbacks.onRetry({ attempt, maxAttempts: CHAT_PROVIDER_MAX_RETRIES, phase: 'waiting', retryAt: Date.now() + delay });
              await waitForRetry(delay, options?.signal);
              options?.signal?.throwIfAborted();
              callbacks.onRetry({ attempt, maxAttempts: CHAT_PROVIDER_MAX_RETRIES, phase: 'requesting' });
              retry = true;
              break;
            }
            // 已建立回复流后不回退，避免重复展示文字或重新执行工具。
            started = true;
            if (retrying) {
              retrying = false;
              callbacks.onSettled();
            }
            output.push(event);
          }
          if (!retry) return;
        }
      } catch (error) {
        const reason = options?.signal?.aborted ? 'aborted' : 'error';
        output.push({
          type: 'error', reason,
          error: {
            ...(lastMessage ?? {
              role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
              usage: {
                input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              timestamp: Date.now(),
            }),
            stopReason: reason,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
      } finally {
        if (retrying) callbacks.onSettled();
        output.end();
      }
    })();

    return output;
  };
}

export { CHAT_PROVIDER_MAX_RETRIES, withProviderRetries };
export type { ProviderRetryStatus };
