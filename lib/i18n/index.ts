/**
 * Cebian 的 i18n 入口：`t` 与「生效界面语言」。
 *
 * All Cebian source code MUST import `t` from here, never from `#i18n`
 * directly. See `.agents/skills/i18n-naming/SKILL.md` for naming, placeholder,
 * and pluralization conventions.
 *
 * 两条路径：
 * - 偏好为 `system`（默认）：不加载任何字典，`t` 直接走 `@wxt-dev/i18n` 的原生
 *   `chrome.i18n.getMessage`，行为与引入手动切换之前完全一致；
 * - 显式选择语言：fetch 扩展包内 `_locales/<locale>/messages.json` 作为覆盖字典，
 *   `t` 优先查它（`format.ts` 复刻原生语义），查不到再回退原生。
 *
 * 每个执行上下文（扩展页 / background / 内容脚本）各自调用一次 `initI18n()`：读偏好、
 * 按需加载字典。`t` 本身保持同步，初始化完成前回退原生。
 *
 * 切换的生效范围：扩展页与内容脚本在加载时固定语言、不跟随存储变化——其他页面里
 * 进行中的录制、未发出的草稿不会因为别处切换语言而被 remount 丢掉；切换只在发起页
 * （`setLanguagePreference`）即时生效，其余页面重开 / 刷新后生效。background 没有 UI
 * 状态可丢，用 `followLanguagePreference()` 持续跟随。
 */
import { i18n } from '#i18n';
import { browser } from 'wxt/browser';
import { languagePreference } from '@/lib/persistence/storage';
import { formatMessage, type Messages, type TranslateArg } from './format';
import { isLanguagePreference, toLanguageTag, type LanguagePreference, type UiLocale } from './locales';

// ─── 运行时状态（每个执行上下文一份） ───

/** 当前生效的显式 locale；`null` = 跟随浏览器。 */
let activeLocale: UiLocale | null = null;
/** 覆盖字典；`null` = 走原生路径。 */
let overrideMessages: Messages | null = null;
let initPromise: Promise<void> | null = null;
let following = false;
/** 发起页选择的序号：连续切换时只让最后一次选择落盘并生效（按选择顺序，而非字典加载完成顺序）。 */
let selectSeq = 0;
/** 竞态序号：连续切换时只让最后一次的结果落地。 */
let applySeq = 0;
/** 最近一次发起的偏好应用；初始化要等到它（而非更早的某次）落地才算完成。 */
let latestApply: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
const dictionaryCache = new Map<UiLocale, Promise<Messages>>();

function loadDictionary(locale: UiLocale): Promise<Messages> {
  let pending = dictionaryCache.get(locale);
  if (!pending) {
    const url = browser.runtime.getURL(`/_locales/${locale}/messages.json` as never);
    pending = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<Messages>;
    });
    // 失败的请求不缓存，下次切换可重试
    pending.catch(() => dictionaryCache.delete(locale));
    dictionaryCache.set(locale, pending);
  }
  return pending;
}

/** 发起一次偏好应用，并记为「最近一次」。 */
function applyPreference(raw: unknown): Promise<void> {
  latestApply = runApply(raw, ++applySeq);
  return latestApply;
}

/** 把偏好落成运行时状态；字典加载失败时保持现状（不 reject），只告警。 */
async function runApply(raw: unknown, seq: number): Promise<void> {
  const preference: LanguagePreference = isLanguagePreference(raw) ? raw : 'system';
  const locale = preference === 'system' ? null : preference;
  let messages: Messages | null = null;
  if (locale) {
    try {
      messages = await loadDictionary(locale);
    } catch (err) {
      if (seq === applySeq) {
        console.warn(`[i18n] failed to load messages for ${locale}, keeping current language:`, err);
      }
      return;
    }
  }
  if (seq !== applySeq) return;
  if (locale === activeLocale && messages === overrideMessages) return;
  activeLocale = locale;
  overrideMessages = messages;
  // 单个订阅者出错不影响其他订阅者，也不让异常冒到 watch 回调里成为 unhandled rejection
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error('[i18n] language change listener failed:', err);
    }
  }
}

// ─── 公开 API ───

/**
 * 初始化本上下文的 i18n（幂等，返回同一个 promise）：读一次偏好并按需加载字典。
 * 永不 reject：任何失败都退回原生路径，调用方可以放心 `await` 它而不必担心挡住页面挂载 /
 * 消息处理。
 */
function initI18n(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        // 读取期间若已有更新的应用（跟随的 watch / 发起页切换），以它为准，丢弃这次可能更旧的读取
        const seqAtRead = applySeq;
        const initial = await languagePreference.getValue();
        if (applySeq === seqAtRead) void applyPreference(initial);
        // 等最近一次应用落地；等待期间又有新的切换就接着等，保证 resolve 时字典已是最新选择
        let current: Promise<void>;
        do {
          current = latestApply;
          await current;
        } while (current !== latestApply);
      } catch (err) {
        console.warn('[i18n] init failed, following the browser language:', err);
      }
    })();
  }
  return initPromise;
}

/**
 * 让本上下文持续跟随偏好变化（幂等）。只给没有 UI 状态的 background 用——扩展页 /
 * 内容脚本跟随会被别处的切换 remount、丢掉进行中的录制与草稿（见文件头）。
 */
function followLanguagePreference(): void {
  if (following) return;
  following = true;
  languagePreference.watch((next) => void applyPreference(next));
}

/**
 * 设置界面语言偏好：持久化，并在当前上下文即时应用（字典就位后通知订阅者，
 * 发起页的 `LocaleRoot` 据此 remount）。其他已打开页面重开 / 刷新后生效。
 *
 * 先确认字典可用再落盘：加载失败时 throw、偏好保持不变，由调用方提示——不会出现
 * 「存储里是 en、页面却还是中文」的静默不一致。成功 resolve 时发起页已 remount，
 * 调用方不要在 await 之后再 setState。连续切换时，字典加载期间被更晚选择取代的调用
 * 直接 resolve（不落盘、不应用、加载或写入失败也不报错）；已经落盘的调用照常应用——依赖
 * chrome.storage 按发起顺序完成同页的连续写入，应用顺序随之与选择顺序一致，`applySeq`
 * 再保证最后一次应用生效。
 */
async function setLanguagePreference(preference: LanguagePreference): Promise<void> {
  const seq = ++selectSeq;
  if (preference !== 'system') {
    try {
      await loadDictionary(preference);
    } catch (err) {
      if (seq === selectSeq) throw err;
      return;
    }
    if (seq !== selectSeq) return;
  }
  try {
    await languagePreference.setValue(preference);
  } catch (err) {
    if (seq === selectSeq) throw err;
    return;
  }
  await applyPreference(preference);
}

/**
 * 本上下文当前生效的语言偏好：加载时读到的，或本页 `setLanguagePreference` 应用后的。
 * 设置 UI 用它显示选中项——不读存储，免得别的窗口改了偏好后，本页显示「已选 English」
 * 文案却还是加载时的语言。
 */
function getActiveLanguagePreference(): LanguagePreference {
  return activeLocale ?? 'system';
}

/**
 * 用户偏好的界面语言（BCP-47）：显式选择的语言，或 `system` 时的浏览器语言 ——
 * `chrome.i18n.getUILanguage()` 的替代品。给「按用户语言产出内容」的地方用：
 * `{{ui_language}}`、日期格式、语音识别、文档链接。浏览器是未支持的语言（如 `ja`）时
 * 它仍是 `ja`，让划词翻译等继续面向用户真正的语言。
 */
function getUiLanguage(): string {
  return activeLocale ? toLanguageTag(activeLocale) : browser.i18n.getUILanguage();
}

/**
 * 界面文案实际所用语言（BCP-47），给 `<html lang>` 用。直接读当前文案字典自己声明的
 * `common.languageTag`：浏览器实际选中哪份 `_locales`（回落规则、系统语言列表）无法从
 * `getUILanguage()` 可靠推出，经同一条 `t()` 路径读出的标签必然与屏幕上的文案一致。
 */
function getDisplayLanguage(): string {
  return t('common.languageTag');
}

/** 订阅界面语言变化（新字典已就位后才回调）；返回取消订阅函数。 */
function onUiLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const t = ((key: string, ...args: TranslateArg[]): string => {
  if (overrideMessages) {
    const message = formatMessage(overrideMessages, key, args);
    if (message !== null) return message;
  }
  return (i18n.t as (key: string, ...args: TranslateArg[]) => string)(key, ...args);
}) as typeof i18n.t;

export {
  t,
  initI18n,
  followLanguagePreference,
  setLanguagePreference,
  getActiveLanguagePreference,
  getUiLanguage,
  getDisplayLanguage,
  onUiLanguageChange,
};
