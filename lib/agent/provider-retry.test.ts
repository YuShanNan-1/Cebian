import { describe, expect, it, vi } from 'vitest';
import {
  isRetryableProviderStatus,
  observeProviderRetries,
} from './provider-retry';

describe('provider retry helpers', () => {
  it('classifies transient HTTP responses without retrying deterministic errors', () => {
    expect(isRetryableProviderStatus(408)).toBe(true);
    expect(isRetryableProviderStatus(409)).toBe(true);
    expect(isRetryableProviderStatus(429)).toBe(true);
    expect(isRetryableProviderStatus(500)).toBe(true);
    expect(isRetryableProviderStatus(502)).toBe(true);
    expect(isRetryableProviderStatus(504)).toBe(true);
    expect(isRetryableProviderStatus(400)).toBe(false);
    expect(isRetryableProviderStatus(401)).toBe(false);
  });

  it('reports retry attempts and settles after a successful response', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const onRetry = vi.fn();
    const onSettled = vi.fn();
    const fetchWithStatus = observeProviderRetries(fetchImpl, 3, onRetry, onSettled);

    await fetchWithStatus('https://example.test');
    await fetchWithStatus('https://example.test');

    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, maxAttempts: 3 });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('reports network failures while the retry budget remains', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network error'));
    const onRetry = vi.fn();
    const fetchWithStatus = observeProviderRetries(fetchImpl, 2, onRetry, vi.fn());

    await expect(fetchWithStatus('https://example.test')).rejects.toThrow('network error');
    await expect(fetchWithStatus('https://example.test')).rejects.toThrow('network error');
    await expect(fetchWithStatus('https://example.test')).rejects.toThrow('network error');

    expect(onRetry.mock.calls).toEqual([
      [{ attempt: 1, maxAttempts: 2 }],
      [{ attempt: 2, maxAttempts: 2 }],
    ]);
  });

  it('does not report retries for an aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    const onRetry = vi.fn();
    const fetchWithStatus = observeProviderRetries(fetchImpl, 3, onRetry, vi.fn());

    await expect(fetchWithStatus('https://example.test', { signal: controller.signal })).rejects.toThrow('Aborted');
    expect(onRetry).not.toHaveBeenCalled();
  });
});
