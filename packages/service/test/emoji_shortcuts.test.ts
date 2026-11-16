import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { describe, expect, it, vi } from 'vitest';
import { buildSystemEmojiShortcuts } from '../src/common/emoji_shortcuts';
import { EmojiService, type PanelFaceGroup } from '../src/account/emoji';
import { createHash } from 'node:crypto';
import nativeShortcuts from '../../../resources/emoji/shortcuts.json';

const faces = [
  { id: '297', desc: '/拜谢' },
  { id: '182', desc: '/笑哭' },
  { id: '14', desc: '/微笑' },
  { id: '76', desc: '/赞' },
  { id: '101', desc: '/坏笑' },
  { id: '123', desc: '/NO' },
  { id: '319', desc: '/比心' },
];
const group: PanelFaceGroup = {
  key: 'system',
  label: '系统表情',
  emojiType: 1,
  unicode: false,
  stickerCount: 0,
  items: faces.map((face) => ({
    ...face,
    unicode: false,
    glyph: '',
    sticker: false,
    packId: '',
    stickerId: '',
    stickerType: 0,
  })),
};
function service() {
  return new EmojiService({ context: {} } as Pick<AccountSession, 'context'>, {} as Platform);
}
describe('系统表情英文短码', () => {
  it('整张数据表与原始 QQNT JSON 摘要一致，不只验证手选的几个别名', () => {
    expect(Object.keys(nativeShortcuts)).toHaveLength(286);
    expect(createHash('sha256').update(JSON.stringify(nativeShortcuts)).digest('hex')).toBe(
      '88b530f98868e01f2e93d0e9dc6a097c5cfa8c2dcaa46e2b60359bb22d4ec7b6',
    );
  });
  it('使用 QQNT 原始别名，bx 是拜谢，不给比心或其他新名称生成拼音短码', () => {
    expect(buildSystemEmojiShortcuts(faces).map((face) => [face.id, face.shortcuts])).toEqual([
      ['297', ['bx']],
      ['182', ['xk']],
      ['14', ['wx', ':)']],
      ['76', ['qiang', 'strong']],
      ['101', ['huaix', 'B-)']],
      ['123', ['bu', 'no']],
      ['319', []],
    ]);
    expect(buildSystemEmojiShortcuts([{ id: '9999', desc: '[全新名称]' }])[0]?.shortcuts).toEqual(
      [],
    );
  });
  it('过滤字符表情 ID，重复系统目录只保留一次', () => {
    expect(buildSystemEmojiShortcuts([...faces, faces[0]!, { id: '😊', desc: '笑' }])).toHaveLength(
      faces.length,
    );
  });
  it('会话内共用在途准备与缓存，返回值不能改写缓存短码', async () => {
    const emoji = service();
    const read = vi.spyOn(emoji, 'listPanelFaces').mockResolvedValue([group]);
    const [first, second] = await Promise.all([
      emoji.listShortcutFaces(),
      emoji.listShortcutFaces(),
    ]);
    first[0]!.shortcuts[0] = 'changed';
    expect(second[0]?.shortcuts[0]).toBe('bx');
    expect((await emoji.listShortcutFaces())[0]?.shortcuts[0]).toBe('bx');
    expect(read).toHaveBeenCalledOnce();
  });
  it('目录暂缺时不永久缓存空索引', async () => {
    const emoji = service();
    const read = vi
      .spyOn(emoji, 'listPanelFaces')
      .mockResolvedValueOnce([])
      .mockResolvedValue([group]);
    expect(await emoji.listShortcutFaces()).toEqual([]);
    expect((await emoji.listShortcutFaces())[0]?.shortcuts[0]).toBe('bx');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
