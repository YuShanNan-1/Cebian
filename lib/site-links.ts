/**
 * site-links — 构造 cebian.catcat.work 上各页面的链接。
 *
 * 可从任意上下文（背景 SW / 侧边栏 / 设置页）导入。站点语言码为 `zh` / `zh-TW` / `en`
 * （见 site/locales.config.mjs），这里把生效界面语言（`getUiLanguage()`，用户手动选择或
 * 浏览器语言，BCP-47 码如 `zh-CN` / `zh-TW` / `en-US`）映射到这三种之一。
 */
import { getUiLanguage } from '@/lib/i18n';

const SITE_ORIGIN = 'https://cebian.catcat.work';

/** 把 UI 语言映射到站点的文档语言码：繁中 → `zh-TW`，其余中文 → `zh`，非中文 → `en`。 */
function resolveDocsLang(): 'zh' | 'zh-TW' | 'en' {
  const subtags = getUiLanguage().toLowerCase().split('-');
  if (subtags[0] !== 'zh') return 'en';
  // 繁体（Hant）及港澳台变体走 zh-TW，其余简体及通用中文走 zh。
  const hant = ['hant', 'tw', 'hk', 'mo'];
  if (subtags.some((tag) => hant.includes(tag))) return 'zh-TW';
  return 'zh';
}

/** 安装指南页（按 UI 语言）。 */
export function getInstallGuideUrl(): string {
  return `${SITE_ORIGIN}/${resolveDocsLang()}/docs/getting-started/installation/`;
}

/**
 * 更新日志页（按 UI 语言）。传入 `version` 时附带 `?v=<version>` 深链，
 * 站点会自动滚动并高亮对应版本卡片（version 不带 `v` 前缀，如 `1.3.3`）。
 */
export function getChangelogUrl(version?: string): string {
  const base = `${SITE_ORIGIN}/${resolveDocsLang()}/changelog/`;
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}
