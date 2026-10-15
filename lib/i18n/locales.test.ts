import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { UI_LOCALES, isLanguagePreference, toLanguageTag } from '@/lib/i18n/locales';

describe('UI_LOCALES', () => {
  it('与 locales/*.yml 的文件集合一致（新增 / 删除语言时两边必须同步）', () => {
    const files = readdirSync(path.resolve(__dirname, '../../locales'))
      .filter((f) => f.endsWith('.yml'))
      .map((f) => f.slice(0, -'.yml'.length))
      .sort();
    expect([...UI_LOCALES].sort()).toEqual(files);
  });
});

describe('toLanguageTag', () => {
  it('locale 码的下划线形式转为 BCP-47 连字符形式', () => {
    expect(toLanguageTag('zh_CN')).toBe('zh-CN');
    expect(toLanguageTag('zh_TW')).toBe('zh-TW');
    expect(toLanguageTag('en')).toBe('en');
  });
});

describe('isLanguagePreference', () => {
  it('接受 system 与已支持的 locale', () => {
    expect(isLanguagePreference('system')).toBe(true);
    for (const locale of UI_LOCALES) expect(isLanguagePreference(locale)).toBe(true);
  });

  it('拒绝未知值与脏值', () => {
    for (const value of ['fr', 'zh-CN', '', null, undefined, 1, {}]) {
      expect(isLanguagePreference(value)).toBe(false);
    }
  });
});
