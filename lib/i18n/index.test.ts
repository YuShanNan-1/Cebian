import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { languagePreference } from '@/lib/persistence/storage';

const DICTIONARIES: Record<string, Record<string, { message: string }>> = {
  en: {
    common_send: { message: 'Send' },
    common_selectedCount: { message: '1 selected | $1 selected' },
    common_languageTag: { message: 'en' },
  },
  zh_TW: { common_send: { message: 'zh_TW:send' }, common_languageTag: { message: 'zh-TW' } },
};

let fetchMock: Mock<(url: string) => Promise<Response>>;
let i18nModule: typeof import('./index');
/** 与 i18nModule 同一模块实例的 storage（resetModules 之后重新导入），用来对其打桩。 */
let storageModule: typeof import('@/lib/persistence/storage');

/** 让 fetch 对某个 locale 挂起，直到调用返回的 release。 */
function holdFetch(locale: string): () => void {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes(`/${locale}/`)) await held;
    return original(url);
  });
  return release;
}

/** 等下一次界面语言变化落地（新字典已就位）。 */
function nextChange(): Promise<void> {
  return new Promise((resolve) => {
    const off = i18nModule.onUiLanguageChange(() => {
      off();
      resolve();
    });
  });
}

beforeEach(async () => {
  fakeBrowser.reset();
  vi.spyOn(fakeBrowser.i18n, 'getMessage').mockImplementation((key: string) => `native:${key}`);
  vi.spyOn(fakeBrowser.i18n, 'getUILanguage').mockReturnValue('zh-CN');
  fetchMock = vi.fn<(url: string) => Promise<Response>>(async (url) => {
    const locale = /_locales\/([^/]+)\/messages\.json$/.exec(url)?.[1] ?? '';
    const dict = DICTIONARIES[locale];
    return dict ? new Response(JSON.stringify(dict)) : new Response('', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  // 模块内有每上下文一份的运行时状态，每个用例用新的模块实例
  vi.resetModules();
  i18nModule = await import('./index');
  storageModule = await import('@/lib/persistence/storage');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('i18n runtime', () => {
  it('默认 system：不加载字典，t 走原生，界面语言取浏览器', async () => {
    await i18nModule.initI18n();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(i18nModule.t('common.send')).toBe('native:common_send');
    expect(i18nModule.getUiLanguage()).toBe('zh-CN');
  });

  it('显式偏好：加载对应字典，t 走覆盖字典，界面语言为该 locale', async () => {
    await languagePreference.setValue('en');
    await i18nModule.initI18n();
    expect(i18nModule.t('common.send')).toBe('Send');
    expect(i18nModule.t('common.selectedCount', 3)).toBe('3 selected');
    expect(i18nModule.getUiLanguage()).toBe('en');
  });

  it('覆盖字典缺 key 时回退原生', async () => {
    await languagePreference.setValue('zh_TW');
    await i18nModule.initI18n();
    expect(i18nModule.t('common.send')).toBe('zh_TW:send');
    expect(i18nModule.t('common.selectedCount', 3)).toBe('native:common_selectedCount');
  });

  it('跟随模式（background）：偏好变化后通知订阅者，切回 system 恢复原生', async () => {
    i18nModule.followLanguagePreference();
    await i18nModule.initI18n();

    let changed = nextChange();
    await languagePreference.setValue('zh_TW');
    await changed;
    expect(i18nModule.t('common.send')).toBe('zh_TW:send');
    expect(i18nModule.getUiLanguage()).toBe('zh-TW');

    changed = nextChange();
    await languagePreference.setValue('system');
    await changed;
    expect(i18nModule.t('common.send')).toBe('native:common_send');
    expect(i18nModule.getUiLanguage()).toBe('zh-CN');
  });

  it('脏值按 system 处理', async () => {
    await fakeBrowser.storage.local.set({ language: 'fr' });
    await i18nModule.initI18n();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(i18nModule.getUiLanguage()).toBe('zh-CN');
  });

  it('字典加载失败：不 reject，保持原生路径', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await languagePreference.setValue('en');
    await expect(i18nModule.initI18n()).resolves.toBeUndefined();
    expect(i18nModule.t('common.send')).toBe('native:common_send');
    expect(i18nModule.getUiLanguage()).toBe('zh-CN');
  });

  it('连续切换：先发起、后返回的旧字典不会覆盖最新选择', async () => {
    i18nModule.followLanguagePreference();
    await i18nModule.initI18n();
    let releaseEn!: () => void;
    const enHeld = new Promise<void>((resolve) => (releaseEn = resolve));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/en/')) await enHeld;
      const locale = /_locales\/([^/]+)\/messages\.json$/.exec(url)?.[1] ?? '';
      return new Response(JSON.stringify(DICTIONARIES[locale]));
    });
    const listener = vi.fn();
    i18nModule.onUiLanguageChange(listener);

    const zhTwApplied = nextChange();
    await languagePreference.setValue('en');
    await languagePreference.setValue('zh_TW');
    await zhTwApplied;
    releaseEn();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(i18nModule.getUiLanguage()).toBe('zh-TW');
    expect(i18nModule.t('common.send')).toBe('zh_TW:send');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('加载失败的字典不缓存：再次切到同一语言会重新请求', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    await languagePreference.setValue('en');
    i18nModule.followLanguagePreference();
    await i18nModule.initI18n();
    expect(i18nModule.t('common.send')).toBe('native:common_send');

    const changed = nextChange();
    await languagePreference.setValue('zh_TW');
    await changed;
    const back = nextChange();
    await languagePreference.setValue('en');
    await back;
    expect(i18nModule.t('common.send')).toBe('Send');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('单个订阅者抛错不影响其他订阅者', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    i18nModule.followLanguagePreference();
    await i18nModule.initI18n();
    i18nModule.onUiLanguageChange(() => {
      throw new Error('boom');
    });
    const changed = nextChange();
    await languagePreference.setValue('en');
    await expect(changed).resolves.toBeUndefined();
  });

  it('首次读取期间 watch 带来新值：丢弃迟到的旧读取，且 init 等到新字典就位才 resolve', async () => {
    let releaseRead!: (value: unknown) => void;
    vi.spyOn(storageModule.languagePreference, 'getValue').mockReturnValue(
      new Promise((resolve) => (releaseRead = resolve)) as never,
    );
    const releaseEn = holdFetch('en');
    let settled = false;
    i18nModule.followLanguagePreference();
    const init = i18nModule.initI18n().then(() => (settled = true));

    await languagePreference.setValue('en');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releaseRead('system');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    releaseEn();
    await init;
    expect(i18nModule.t('common.send')).toBe('Send');
    expect(i18nModule.getUiLanguage()).toBe('en');
  });

  it('首个字典加载期间再次切换：init resolve 时已是最后的选择', async () => {
    await languagePreference.setValue('zh_TW');
    const releaseZhTw = holdFetch('zh_TW');
    i18nModule.followLanguagePreference();
    const init = i18nModule.initI18n();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await languagePreference.setValue('en');
    releaseZhTw();
    await init;
    expect(i18nModule.t('common.send')).toBe('Send');
    expect(i18nModule.getUiLanguage()).toBe('en');
  });

  it('默认不跟随（扩展页 / 内容脚本）：别处改了偏好，本上下文保持加载时的语言', async () => {
    await i18nModule.initI18n();
    const listener = vi.fn();
    i18nModule.onUiLanguageChange(listener);
    await languagePreference.setValue('en');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(i18nModule.t('common.send')).toBe('native:common_send');
    // 设置 UI 的选中项也保持本页实际所用的偏好
    expect(i18nModule.getActiveLanguagePreference()).toBe('system');
  });

  it('setLanguagePreference：持久化并在当前上下文即时生效、通知订阅者', async () => {
    await i18nModule.initI18n();
    const listener = vi.fn();
    i18nModule.onUiLanguageChange(listener);
    expect(i18nModule.getActiveLanguagePreference()).toBe('system');
    await i18nModule.setLanguagePreference('en');
    expect(await languagePreference.getValue()).toBe('en');
    expect(i18nModule.getActiveLanguagePreference()).toBe('en');
    expect(i18nModule.t('common.send')).toBe('Send');
    expect(listener).toHaveBeenCalledTimes(1);

    await i18nModule.setLanguagePreference('system');
    expect(i18nModule.t('common.send')).toBe('native:common_send');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('setLanguagePreference 连续调用：按选择顺序最后一次生效，先发起的慢加载不会覆盖', async () => {
    await i18nModule.initI18n();
    const releaseEn = holdFetch('en');
    const first = i18nModule.setLanguagePreference('en');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await i18nModule.setLanguagePreference('zh_TW');
    releaseEn();
    await first;

    expect(await languagePreference.getValue()).toBe('zh_TW');
    expect(i18nModule.t('common.send')).toBe('zh_TW:send');
    expect(i18nModule.getUiLanguage()).toBe('zh-TW');
  });

  it('setLanguagePreference：被更晚选择取代的调用加载失败时不报错', async () => {
    await i18nModule.initI18n();
    let rejectEn!: (err: Error) => void;
    const enFailed = new Promise<never>((_, reject) => (rejectEn = reject));
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string) => (url.includes('/en/') ? enFailed : original(url)));
    const first = i18nModule.setLanguagePreference('en');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await i18nModule.setLanguagePreference('zh_TW');
    rejectEn(new Error('offline'));
    await expect(first).resolves.toBeUndefined();
    expect(await languagePreference.getValue()).toBe('zh_TW');
  });

  it('setLanguagePreference：被更晚选择取代的调用存储写入失败时不报错', async () => {
    await i18nModule.initI18n();
    let rejectFirstWrite!: (err: Error) => void;
    const realSet = storageModule.languagePreference.setValue.bind(storageModule.languagePreference);
    vi.spyOn(storageModule.languagePreference, 'setValue')
      .mockImplementationOnce(() => new Promise<void>((_, reject) => (rejectFirstWrite = reject)))
      .mockImplementation(realSet);
    const first = i18nModule.setLanguagePreference('en');
    await vi.waitFor(() => expect(rejectFirstWrite).toBeTypeOf('function'));
    const second = i18nModule.setLanguagePreference('zh_TW');
    rejectFirstWrite(new Error('quota'));
    await expect(first).resolves.toBeUndefined();
    await second;
    expect(await languagePreference.getValue()).toBe('zh_TW');
    expect(i18nModule.getActiveLanguagePreference()).toBe('zh_TW');
  });

  it('setLanguagePreference：字典加载失败时 throw，偏好与当前语言都不变', async () => {
    await i18nModule.initI18n();
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    await expect(i18nModule.setLanguagePreference('en')).rejects.toThrow();
    expect(await languagePreference.getValue()).toBe('system');
    expect(i18nModule.t('common.send')).toBe('native:common_send');
  });

  it('getDisplayLanguage 取当前文案字典声明的标签，与浏览器语言无关；getUiLanguage 仍是用户语言', async () => {
    // 模拟浏览器 UI 语言为未支持的 ja、原生实际渲染了 en 字典
    vi.mocked(fakeBrowser.i18n.getUILanguage).mockReturnValue('ja');
    vi.mocked(fakeBrowser.i18n.getMessage).mockImplementation((key: string) =>
      key === 'common_languageTag' ? 'en' : `native:${key}`,
    );
    await i18nModule.initI18n();
    expect(i18nModule.getDisplayLanguage()).toBe('en');
    expect(i18nModule.getUiLanguage()).toBe('ja');

    await i18nModule.setLanguagePreference('zh_TW');
    expect(i18nModule.getDisplayLanguage()).toBe('zh-TW');
    expect(i18nModule.getUiLanguage()).toBe('zh-TW');
  });

  it('initI18n 幂等：重复调用返回同一个 promise', async () => {
    const first = i18nModule.initI18n();
    expect(i18nModule.initI18n()).toBe(first);
    await first;
  });
});
