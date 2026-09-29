/** Provider-level retry status helpers used by the chat agent only. */

export const CHAT_PROVIDER_MAX_RETRIES = 3;

export interface ProviderRetryStatus {
  attempt: number;
  maxAttempts: number;
}

export function isRetryableProviderStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export type RetryStatusCallback = (status: ProviderRetryStatus) => void;

export function observeProviderRetries(
  fetchImpl: typeof fetch,
  maxRetries: number,
  onRetry: RetryStatusCallback,
  onSettled: () => void,
): typeof fetch {
  let attempt = 0;
  return async (input, init) => {
    try {
      const response = await fetchImpl(input, init);
      if (isRetryableProviderStatus(response.status)) {
        if (attempt < maxRetries) {
          attempt++;
          onRetry({ attempt, maxAttempts: maxRetries });
        }
      } else if (response.ok) {
        if (attempt > 0) onSettled();
        attempt = 0;
      }
      return response;
    } catch (error) {
      if (init?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      if (attempt < maxRetries) {
        attempt++;
        onRetry({ attempt, maxAttempts: maxRetries });
      }
      throw error;
    }
  };
}
