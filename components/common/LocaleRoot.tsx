import { Fragment, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { getDisplayLanguage, onUiLanguageChange } from '@/lib/i18n';

/**
 * 扩展页的语言根：本页切换界面语言（`setLanguagePreference`）后整体 remount 子树，让所有
 * `t()` 文案（含 useMemo 缓存的）一次换成新语言；并同步 `<html lang>`（CJK 字形选择 / 读屏
 * 依赖它）。lang 用界面文案实际所用的语言，保证与屏幕上的文案一致。
 *
 * remount 的 key 用「字典换了几次」而不是语言标签：每次通知都意味着字典真的换了，
 * 即使显示语言标签不变（如 system 下原生渲染的就是 en，再显式选 en）也照样 remount。
 */
export function LocaleRoot({ children }: { children: ReactNode }) {
  const [generation, setGeneration] = useState(0);
  // 页面在 initI18n 完成后才渲染，挂载前不会错过切换
  useEffect(() => onUiLanguageChange(() => setGeneration((g) => g + 1)), []);

  const lang = getDisplayLanguage();
  // layout effect：首帧绘制前就换掉 HTML 里写死的 lang="en"，中文页不会先按英文字体画一帧
  useLayoutEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return <Fragment key={generation}>{children}</Fragment>;
}
