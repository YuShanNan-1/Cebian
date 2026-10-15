import { describe, it, expect } from 'vitest';
import { formatMessage, type Messages } from '@/lib/i18n/format';

const messages: Messages = {
  common_send: { message: 'Send' },
  common_greet: { message: 'Hello $1, you have $2' },
  common_swap: { message: '$2 before $1' },
  common_price: { message: 'Costs $$5 for $1' },
  common_selectedCount: { message: '1 selected | $1 selected' },
  common_files: { message: 'No files | One file | $1 files' },
  common_named: { message: 'Hi {name}, keep {unknown}' },
  common_code: { message: 'function transform(text, vars) {…}' },
};

describe('formatMessage', () => {
  it('key 的 . 映射到 messages.json 的 _', () => {
    expect(formatMessage(messages, 'common.send', [])).toBe('Send');
  });

  it('字典里没有的 key 返回 null（由调用方回退原生）', () => {
    expect(formatMessage(messages, 'common.missing', [])).toBeNull();
  });

  it('位置替换：按 $N 序号取值，支持语序调换', () => {
    expect(formatMessage(messages, 'common.greet', [['Kim', 3]])).toBe('Hello Kim, you have 3');
    expect(formatMessage(messages, 'common.swap', [['a', 'b']])).toBe('b before a');
  });

  it('缺失的替换值按 getMessage 语义替换为空串', () => {
    expect(formatMessage(messages, 'common.greet', [['Kim']])).toBe('Hello Kim, you have ');
  });

  it('$$ 还原为字面 $，且不被当作占位符', () => {
    expect(formatMessage(messages, 'common.price', [['you']])).toBe('Costs $5 for you');
  });

  it('连续 k 个 $ 输出 k−1 个（Chromium / Firefox 语义），其后的数字按字面保留', () => {
    const dollars: Messages = {
      a_four: { message: '$$$$' },
      a_three: { message: '$$$1' },
    };
    expect(formatMessage(dollars, 'a.four', [])).toBe('$$$');
    expect(formatMessage(dollars, 'a.three', [['X']])).toBe('$$1');
  });

  it('非法参数与 WXT 一致地抛错（带参数位置）', () => {
    expect(() => formatMessage(messages, 'common.send', [true as never])).toThrow(/index 0/);
  });

  it('两段复数：count === 1 取第一段，其余取第二段；count 兜底作为 $1', () => {
    expect(formatMessage(messages, 'common.selectedCount', [1])).toBe('1 selected');
    expect(formatMessage(messages, 'common.selectedCount', [0])).toBe('0 selected');
    expect(formatMessage(messages, 'common.selectedCount', [5])).toBe('5 selected');
  });

  it('三段复数：0 / 1 / 其他', () => {
    expect(formatMessage(messages, 'common.files', [0])).toBe('No files');
    expect(formatMessage(messages, 'common.files', [1])).toBe('One file');
    expect(formatMessage(messages, 'common.files', [7])).toBe('7 files');
  });

  it('count 与显式替换数组同时给出时，用替换数组', () => {
    expect(formatMessage(messages, 'common.selectedCount', [2, ['two']])).toBe('two selected');
  });

  it('命名替换只替换给出的名字，未知名字原样保留', () => {
    expect(formatMessage(messages, 'common.named', [{ name: 'Kim' }])).toBe('Hi Kim, keep {unknown}');
  });

  it('不传命名替换时花括号原样保留', () => {
    expect(formatMessage(messages, 'common.code', [])).toBe('function transform(text, vars) {…}');
  });

  it('null / undefined 参数被忽略', () => {
    expect(formatMessage(messages, 'common.greet', [null, ['A', 'B'], undefined])).toBe('Hello A, you have B');
  });
});
