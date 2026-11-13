// @vitest-environment node
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { TipGroupElementType } from '@weq/codec';
import {
  previewNodes,
  previewNodesToText,
  previewIdentityIds,
} from '../src/renderer/src/lib/conversationPreview.ts';

const preview = {
  kind: 'grayTipPoke',
  grayTipXmlContent:
    '<gtip><qq uin="u_alice" nm=""/><nor txt="戳了戳"/><qq uin="u_self" nm=""/></gtip>',
  actionAttributes: [
    { key: 'uin_str1', value: '12345' },
    { key: 'uin_str2', value: '67890' },
  ],
};
const text = (p = preview, names = new Map<string, string>()) =>
  previewNodesToText(previewNodes(p, new Set(['u_self', '67890']), names));

test('撤回预览包含操作者、撤回提示和自定义后缀', () => {
  const revoke = {
    kind: 'grayTipRevoke',
    recallSenderUid: 'u_alice',
    recallRevokeUid: 'u_alice',
    recallSenderNick: '旧昵称',
    recallRevokeNick: '旧昵称',
    recallDisplayText: '并坏笑了一下。',
  };
  const names = new Map([['u_alice', '本地备注']]);
  assert.equal(
    previewNodesToText(previewNodes(revoke, new Set(), names)),
    '本地备注 撤回了一条消息 并坏笑了一下。',
  );
  assert.equal(
    previewNodesToText(previewNodes({ ...revoke, recallDisplayText: '' }, new Set(), names)),
    '本地备注 撤回了一条消息',
  );
  assert.equal(
    previewNodesToText(previewNodes(revoke, new Set(['u_alice']), names)),
    '你 撤回了一条消息 并坏笑了一下。',
  );
});

test('管理员撤回预览区分同名的操作者和原作者，不附加个人撤回后缀', () => {
  assert.equal(
    previewNodesToText(
      previewNodes({
        kind: 'grayTipRevoke',
        recallSenderUid: 'u_alice',
        recallRevokeUid: 'u_admin',
        recallSenderNick: '同名',
        recallRevokeNick: '同名',
        recallDisplayText: '并坏笑了一下。',
      }),
    ),
    '同名 撤回了一条 同名 的消息',
  );
});

test('QQ 精简撤回预览仅带原发送者时，使用其本地名称或内嵌昵称', () => {
  // 对应实际 40051 的字段形态：47704/47705 存在，47703/47714 缺失。
  const revoke = {
    kind: 'grayTipRevoke',
    recallSenderUid: 'u_alice',
    recallSenderNick: '消息昵称',
    displayText: '撤回了一条消息',
  };
  for (const [self, names, expected] of [
    [new Set<string>(), new Map<string, string>(), '消息昵称 撤回了一条消息'],
    [new Set<string>(), new Map([['u_alice', '本地备注']]), '本地备注 撤回了一条消息'],
    [new Set<string>(), new Map([['u_alice', '本地群名片']]), '本地群名片 撤回了一条消息'],
    [new Set(['u_alice']), new Map<string, string>(), '你 撤回了一条消息'],
  ] as const) {
    assert.equal(previewNodesToText(previewNodes(revoke, self, names)), expected);
    assert.equal(
      previewNodesToText(previewNodes({ ...revoke, previewElements: [revoke] }, self, names)),
      expected,
    );
  }
});

test('同一身份的撤回预览可复用另一角色的昵称，不串用管理员和原作者名称', () => {
  assert.equal(
    previewNodesToText(
      previewNodes({
        kind: 'grayTipRevoke',
        recallSenderUid: 'u_alice',
        recallRevokeUid: 'u_alice',
        recallRevokeGroupNick: '群名片',
      }),
    ),
    '群名片 撤回了一条消息',
  );
  assert.equal(
    previewNodesToText(
      previewNodes({
        kind: 'grayTipRevoke',
        recallSenderUid: 'u_alice',
        recallRevokeUid: 'u_admin',
        recallSenderNick: '原作者',
      }),
    ),
    '某成员 撤回了一条 原作者 的消息',
  );
});

test('撤回预览兼容已有完整文案，缺失身份时仍保留完整动作', () => {
  for (const [fields, expected] of [
    [{ recallDisplayText: '对方撤回了一条消息' }, '对方撤回了一条消息'],
    [{ displayText: '对方撤回了一条消息' }, '对方撤回了一条消息'],
    [{ recallRevokeNick: '昵称', recallDisplayText: '撤回了一条消息' }, '昵称 撤回了一条消息'],
    [{ recallRevokeGroupNick: '群名片', recallRevokeNick: '昵称' }, '群名片 撤回了一条消息'],
    [{ recallRevokeNickCopy: '昵称副本' }, '昵称副本 撤回了一条消息'],
    [{ recallSenderNick: '原作者', recallRevokeNick: '操作者' }, '操作者 撤回了一条消息'],
    [{ recallSenderNick: '原作者', recallRevokeUid: 'u_unknown' }, '某成员 撤回了一条消息'],
    [{}, '某成员 撤回了一条消息'],
  ] as const) {
    assert.equal(previewNodesToText(previewNodes({ kind: 'grayTipRevoke', ...fields })), expected);
  }
});

test('撤回灰条补全操作者和原作者的本地身份，混合预览也不遗漏', () => {
  const revoke = {
    kind: 'grayTipRevoke',
    recallSenderUid: 'u_alice',
    recallRevokeUid: 'u_admin',
  };
  assert.deepEqual(previewIdentityIds(revoke, 'u_admin'), ['u_admin', 'u_alice']);
  assert.deepEqual(previewIdentityIds({ previewElements: [revoke] }), ['u_alice', 'u_admin']);
});

test('表情图按子类型显示表情摘要，普通 GIF 仍是图片', () => {
  assert.equal(
    previewNodesToText(previewNodes({ kind: 'pic', subType: 1, displayText: '[图片]' })),
    '[表情]',
  );
  assert.equal(previewNodesToText(previewNodes({ kind: 'pic', subType: 1 })), '[表情]');
  assert.equal(
    previewNodesToText(previewNodes({ kind: 'pic', subType: 0, imgType: 2000 })),
    '[图片]',
  );
});

test('群名修改摘要使用协议事件与新群名，不误报成员退出', () => {
  for (const [fields, expected] of [
    [{ user1Nick: '管理员', groupTipGroupName: '新群名' }, '管理员 修改群名为 新群名'],
    [
      { user1Nick: '昵称', user1GroupNick: '群名片', groupTipGroupName: '新群名' },
      '群名片 修改群名为 新群名',
    ],
    [{ groupTipGroupName: '新群名' }, '修改群名为 新群名'],
    [{ user1Nick: '管理员' }, '管理员 修改了群名'],
    [{}, '修改了群名'],
  ] as const) {
    const nodes = previewNodes({
      kind: 'grayTipGroup',
      groupTipType: TipGroupElementType.KGROUPNAMEMODIFIED,
      ...fields,
    });
    assert.equal(previewNodesToText(nodes), expected);
    assert.ok(!previewNodesToText(nodes).includes('退出'));
  }
});

test('mixed message previews keep ordered text and every face, including face zero', () => {
  assert.deepEqual(
    previewNodes({
      kind: 'text',
      textContent: '你好',
      previewElements: [
        { kind: 'text', textContent: '你好' },
        { kind: 'face', faceId: 0, displayText: '/惊讶' },
        { kind: 'text', textContent: '！' },
        { kind: 'face', faceId: 14, displayText: '/微笑' },
      ],
    }),
    [
      { t: 'text', text: '你好' },
      { t: 'face', faceId: 0, label: '/惊讶' },
      { t: 'text', text: '！' },
      { t: 'face', faceId: 14, label: '/微笑' },
    ],
  );
});

test('markdown fallback text does not duplicate the same message in a preview', () => {
  assert.equal(
    previewNodesToText(
      previewNodes({
        previewElements: [
          { kind: 'markdown', markdownContent49099: '正文' },
          { kind: 'text', textContent: '正文' },
        ],
      }),
    ),
    '正文',
  );
});

test('mixed preview preserves spaces around emoji', () => {
  assert.equal(
    previewNodesToText(
      previewNodes({
        previewElements: [
          { kind: 'text', textContent: 'hello ' },
          { kind: 'face', faceId: 14, displayText: '/微笑' },
          { kind: 'text', textContent: ' world' },
        ],
      }),
    ),
    'hello /微笑 world',
  );
});

test('poke resolves exact UID to a cached nickname', () => {
  assert.equal(text(preview, new Map([['u_alice', 'Alice']])), 'Alice戳了戳你');
});
test('poke resolves an exact UIN alias when UID profile is absent', () => {
  assert.equal(text(preview, new Map([['12345', 'Alice']])), 'Alice戳了戳你');
});
test('missing nickname retains the QQ number, never guesses by substring', () => {
  assert.equal(text(preview, new Map([['123456', 'Wrong']])), '12345戳了戳你');
});
test('an embedded QQ-number placeholder still resolves to a nickname', () => {
  const p = { ...preview, actionInitiator: { uid: 'u_alice', nickname: '12345' } };
  assert.equal(text(p, new Map([['u_alice', 'Alice']])), 'Alice戳了戳你');
});
test('embedded nickname remains authoritative over current profile', () => {
  assert.equal(
    text(
      { ...preview, grayTipXmlContent: preview.grayTipXmlContent.replace('nm=""', 'nm="Then"') },
      new Map([['u_alice', 'Now']]),
    ),
    'Then戳了戳你',
  );
});
test('numeric XML label is a fallback, not a nickname', () => {
  assert.equal(
    text(
      { ...preview, grayTipXmlContent: preview.grayTipXmlContent.replace('nm=""', 'nm="12345"') },
      new Map([['u_alice', 'Alice']]),
    ),
    'Alice戳了戳你',
  );
});
test('JSON preview follows the same identity lookup and self handling', () => {
  const nodes = previewNodes(
    {
      kind: 'grayTipPoke',
      tipJson: JSON.stringify({
        items: [
          { type: 'qq', uid: 'u_alice' },
          { type: 'nor', txt: '戳了戳' },
          { type: 'qq', uid: 'u_self' },
        ],
      }),
    },
    new Set(['u_self']),
    new Map([['u_alice', 'Alice']]),
  );
  assert.equal(previewNodesToText(nodes), 'Alice戳了戳你');
});
test('JSON 预览的人物参数解析昵称及本人，普通链接不占人物序号', () => {
  assert.equal(
    previewNodesToText(
      previewNodes(
        {
          kind: 'grayTipPoke',
          tipJson: JSON.stringify({
            items: [
              { type: 'url', param: ['https://example.invalid'], txt: '链接' },
              { type: 'url', param: ['u_alice'], txt: 'u_alice' },
              { type: 'nor', txt: '戳了戳' },
              { type: 'url', param: ['u_self'], txt: 'u_self' },
            ],
          }),
        },
        new Set(['u_self']),
        new Map([['u_alice', 'Alice']]),
      ),
    ),
    '链接Alice戳了戳你',
  );
});
test('profile prefetch collects only identities from person nodes', () => {
  assert.deepEqual(previewIdentityIds(preview), ['u_alice', 'u_self']);
  assert.deepEqual(previewIdentityIds({ kind: 'text', textContent: 'u_not_a_person' }), []);
});
test('灰条预取补齐 XML 身份别名与 JSON 人物参数，不收集普通动作链接', () => {
  assert.deepEqual(
    previewIdentityIds({
      kind: 'grayTipPoke',
      grayTipXmlContent: "<gtip><qq uid='u_alice' jp='u_bob'/></gtip>",
      tipJson: JSON.stringify({
        items: [
          { type: 'url', param: ['u_carol'] },
          { type: 'qq', uid: 'u_dave', uin: '10009' },
          { type: 'url', param: ['https://example.invalid'] },
          { type: 'url', param: ['12345'] },
          { type: 'nor', uid: 'u_not_a_person' },
        ],
      }),
    }),
    ['u_alice', 'u_bob', 'u_carol', 'u_dave', '10009'],
  );
});
test('普通消息和空预览也补全发送者，灰条中的同一身份不重复补全', () => {
  assert.deepEqual(
    previewIdentityIds({ kind: 'text', textContent: 'u_not_a_person' }, 'u_sender'),
    ['u_sender'],
  );
  assert.deepEqual(previewIdentityIds({ kind: 'face', faceId: 76 }, 'u_sender'), ['u_sender']);
  assert.deepEqual(previewIdentityIds(null, 'u_sender'), ['u_sender']);
  assert.deepEqual(previewIdentityIds(preview, 'u_alice'), ['u_alice', 'u_self']);
  assert.deepEqual(previewIdentityIds(null, ''), []);
});
test('malformed preview identities never reach the UID resolver or crash rendering', () => {
  const bad = {
    kind: 'grayTipPoke',
    tipJson: JSON.stringify({
      items: [null, { type: 'qq', uid: {} }, { type: 'qq', uid: 'u_alice' }],
    }),
  };
  assert.deepEqual(previewIdentityIds(bad), ['u_alice']);
  assert.doesNotThrow(() => previewNodes(bad));
});
