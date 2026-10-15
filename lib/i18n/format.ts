/**
 * 覆盖字典的消息格式化 —— 纯函数，复刻「`@wxt-dev/i18n` 的 `t` + `chrome.i18n.getMessage`」
 * 合起来的语义，保证显式选择语言时与原生路径的输出逐字一致：
 *
 * 1. key 的 `.` 换成 `_`（构建产物 messages.json 的键名）；
 * 2. `$1`–`$9` 按位置替换（缺失的替换为空串）；连续 k 个 `$` 输出 k−1 个
 *    （Chromium `ReplaceStringPlaceholders` / Firefox `localizeMessage` 的语义：去掉首个）；
 * 3. 传了 count 而没传替换数组时，count 本身作为 `$1`；
 * 4. 传了 count 时按 ` | ` 拆复数：2 段 = 1 / 其他，3 段 = 0 / 1 / 其他；
 * 5. 最后应用 `{name}` 命名替换。
 *
 * 前提：messages.json 不含 `placeholders` 块，文案里的 `$` 只有单个数字的 `$1`–`$9` 与不紧跟
 * 数字的 `$$`（`$x`、`$10`、`$$$` 等两家浏览器语义有分歧或易误读）—— 由 `scripts/lint-i18n.mjs` 锁住。
 */

/** `_locales/<locale>/messages.json` 的形状（只用到 message 字段）。 */
type Messages = Record<string, { message: string }>;

type Substitution = string | number;
type NamedSubstitutions = Record<string, Substitution>;
type TranslateArg = number | Substitution[] | NamedSubstitutions | null | undefined;

const POSITIONAL_RE = /\$(\$+|[1-9])/g;
const NAMED_RE = /\{([A-Za-z0-9_]+)\}/g;

function selectPlural(message: string, count: number): string {
  const forms = message.split(' | ');
  switch (forms.length) {
    case 1:
      return forms[0];
    case 2:
      return forms[count === 1 ? 0 : 1];
    case 3:
      return forms[count === 0 || count === 1 ? count : 2];
    default:
      throw new Error('Unknown plural formatting');
  }
}

/** 按字典格式化一条消息；字典里没有该 key 时返回 `null`，由调用方回退原生路径。 */
function formatMessage(messages: Messages, key: string, args: TranslateArg[]): string | null {
  const entry = messages[key.replaceAll('.', '_')];
  if (!entry) return null;

  let subs: Substitution[] | undefined;
  let named: NamedSubstitutions | undefined;
  let count: number | undefined;
  for (const [i, arg] of args.entries()) {
    if (arg == null) continue;
    if (typeof arg === 'number') count = arg;
    else if (Array.isArray(arg)) subs = arg;
    else if (typeof arg === 'object') named = arg;
    else
      throw new Error(
        `Unknown argument at index ${i}. Must be a number for pluralization, substitution array, or named substitution object.`,
      );
  }
  if (count != null && subs == null) subs = [count];

  let message = entry.message.replace(POSITIONAL_RE, (_, token: string) =>
    token[0] === '$' ? token : String(subs?.[Number(token) - 1] ?? ''),
  );
  if (count != null) message = selectPlural(message, count);
  if (named) {
    const values = named;
    message = message.replace(NAMED_RE, (match, name: string) =>
      Object.hasOwn(values, name) ? String(values[name]) : match,
    );
  }
  return message;
}

export { formatMessage };
export type { Messages, TranslateArg };
