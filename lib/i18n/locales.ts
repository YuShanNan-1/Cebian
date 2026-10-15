/**
 * 界面语言清单 —— 纯数据 + 纯函数，无任何 import，可从任意上下文（含 storage 类型声明）引用。
 *
 * 新增语言时：在 `locales/` 加对应 yml，再把 locale 追加到 `UI_LOCALES` 并补齐
 * `LANGUAGE_TAGS`（`locales.test.ts` 校验 `UI_LOCALES` 与 yml 文件集合一致，
 * `LANGUAGE_TAGS` 的完整性由 `Record<UiLocale, string>` 在编译期保证）。
 */

/** 一个界面语言的 locale 码，与 `locales/<code>.yml` / `_locales/<code>/` 目录名一致。 */
type UiLocale = (typeof UI_LOCALES)[number];

/** 用户的界面语言偏好：`system` = 跟随浏览器（走原生 chrome.i18n），其余为显式指定。 */
type LanguagePreference = 'system' | UiLocale;

/** locale 码 → BCP-47 语言标签（`document.lang`、`Intl`、站点语言映射都用这一种写法）。 */
const LANGUAGE_TAGS: Record<UiLocale, string> = {
  en: 'en',
  zh_CN: 'zh-CN',
  zh_TW: 'zh-TW',
};

const UI_LOCALES = ['en', 'zh_CN', 'zh_TW'] as const;

function toLanguageTag(locale: UiLocale): string {
  return LANGUAGE_TAGS[locale];
}

/** 存储里读出的值是否为合法偏好（防御旧版本 / 手改 / 备份恢复带来的脏值）。 */
function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || (UI_LOCALES as readonly unknown[]).includes(value);
}

export { UI_LOCALES, toLanguageTag, isLanguagePreference };
export type { UiLocale, LanguagePreference };
