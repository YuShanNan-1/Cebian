import { describe, expect, it } from 'vitest';
import { resolveSkillAssetPath, skillAssetsRoot } from '@/lib/tools/vfs-whitelist';

describe('skill asset paths', () => {
  const root = skillAssetsRoot('chaoxing-exam');

  it('resolves files only within the named skill directory', () => {
    expect(resolveSkillAssetPath('assets/font/table.json', root)).toBe(
      `${root}/assets/font/table.json`,
    );
    expect(() => resolveSkillAssetPath('../another-skill/secret.json', root)).toThrow(/escapes/);
    expect(() => resolveSkillAssetPath('/home/user/private.json', root)).toThrow(/relative/);
    expect(() => resolveSkillAssetPath('.', root)).toThrow(/must name a file/);
  });

  it('rejects invalid skill names and roots outside the installed skills directory', () => {
    expect(() => skillAssetsRoot('../another-skill')).toThrow(/Invalid skill name/);
    expect(() => resolveSkillAssetPath('asset.json', '/workspaces/session-1/chaoxing-exam')).toThrow(
      /outside the installed skills directory/,
    );
  });
});
