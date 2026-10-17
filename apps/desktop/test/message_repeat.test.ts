import { describe, expect, it } from 'vitest';
import { FaceSubType } from '@weq/codec';
import {
  repeatSendPlan,
  repeatTarget,
  type RepeatElement,
} from '../src/renderer/src/lib/messageRepeat';
import {
  mentionClipboardHtml,
  readMentionClipboard,
} from '../src/renderer/src/lib/mentionClipboard';
import { resolveMentionLabels, resolveSendMentions } from '../src/renderer/src/lib/mentionIdentity';
import { buildComposerSendPlan } from '../src/renderer/src/im-template/template/composerSend';
import { elementsToComposerText } from '../src/renderer/src/im-template/template/draftElements';
import { filterMentionMembers } from '../src/renderer/src/im-template/template/mentions';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

const plain = (value: string): RepeatElement => ({ type: 'text', data: { textContent: value } });
const mention = (uid: string, label: string): RepeatElement => ({
  type: 'at',
  data: { atTargetUid: uid, textContent: label },
});
const message = (id: string, elements: RepeatElement[]) => ({ id, qqElements: elements });

describe('最新连续消息 +1', () => {
  it('最近两条相同才在最新一条出现，历史、灰条、失败和撤回不跳过', () => {
    const first = message('a', [plain('相同')]);
    const last = message('b', [plain('相同')]);
    expect(repeatTarget([first, last], true)).toBe(last);
    expect(repeatTarget([first, last], false)).toBeNull();
    expect(repeatTarget([first, last, message('c', [plain('不同')])], true)).toBeNull();
    expect(repeatTarget([first, message('tip', [{ type: 'grayTipPoke' }]), last], true)).toBeNull();
    expect(repeatTarget([first, { ...last, optimistic: 'failed' }], true)).toBeNull();
    expect(repeatTarget([first, { ...last, recall: {} }], true)).toBeNull();
  });
  it('比较实际元素而不是预览标签，文本切段和缓存元信息不影响同一内容', () => {
    expect(
      repeatTarget([message('a', [plain('ab')]), message('b', [plain('a'), plain('b')])], true)?.id,
    ).toBe('b');
    const pic = (md5: string, token: string) => ({
      type: 'pic',
      data: { md5, fileToken: token, elementId: token },
    });
    expect(
      repeatTarget([message('a', [pic('aa', 'a')]), message('b', [pic('AA', 'b')])], true)?.id,
    ).toBe('b');
    expect(
      repeatTarget([message('a', [pic('aa', 'a')]), message('b', [pic('bb', 'b')])], true),
    ).toBeNull();
    expect(
      repeatTarget(
        [message('a', [mention('u_a', '@甲')]), message('b', [mention('u_b', '@甲')])],
        true,
      ),
    ).toBeNull();
    expect(
      repeatTarget(
        [message('a', [mention('u_a', '@对方备注')]), message('b', [mention('u_a', '@我的备注')])],
        true,
      )?.id,
    ).toBe('b');
  });
  it('商城贴纸保留贴纸 GUID、包和密钥，普通/超级/随机表情保留对应协议形态', () => {
    expect(
      repeatSendPlan(
        [{ type: 'face', data: { faceId: 324, subType: FaceSubType.QQ_BUILTIN_NEW } }],
        new Map(),
        false,
      ),
    ).toMatchObject({
      kind: 'elements',
      elements: [{ kind: 'face', faceId: 324, smallFace: true }],
    });
    const plan = repeatSendPlan(
      [
        {
          type: 'mface',
          data: {
            marketEmoticonIdHex: 'a'.repeat(32),
            emojiPackId: 23,
            encryptKey: 'fixture',
            faceName: '贴纸',
          },
        },
      ],
      new Map(),
      true,
    );
    expect(plan).toMatchObject({
      kind: 'elements',
      elements: [
        { kind: 'mface', marketEmoticonId: 'a'.repeat(32), emojiPackId: 23, encryptKey: 'fixture' },
      ],
    });
    expect(
      repeatSendPlan(
        [{ type: 'face', data: { faceId: 324, subType: FaceSubType.QQ_BUILTIN_OLD } }],
        new Map(),
        false,
      ),
    ).toMatchObject({
      kind: 'elements',
      elements: [{ kind: 'face', faceId: 324, smallFace: true }],
    });
    expect(
      repeatSendPlan(
        [{ type: 'face', data: { faceId: 358, subType: FaceSubType.SUPER_EMOJI, innerId: '4' } }],
        new Map([['358', { packId: '1', stickerId: '2' }]]),
        true,
      ),
    ).toMatchObject({
      kind: 'elements',
      elements: [{ superSticker: { packId: '1', stickerId: '2', resultId: '4' } }],
    });
    expect(() =>
      repeatSendPlan(
        [{ type: 'face', data: { faceId: 358, subType: FaceSubType.SUPER_EMOJI } }],
        new Map(),
        true,
      ),
    ).toThrow('超级表情目录');
  });
  it('图片复用已有指纹上传，不依赖复制文字或把媒体降为占位', () => {
    const plan = repeatSendPlan(
      [
        {
          type: 'pic',
          data: {
            md5: 'a'.repeat(32),
            contentHash: 'b'.repeat(40),
            fileSize: 123,
            imgWidth: 40,
            imgHeight: 50,
            subType: 1,
          },
        },
      ],
      new Map(),
      false,
    );
    expect(plan).toMatchObject({
      kind: 'elements',
      elements: [
        {
          kind: 'image',
          subType: 1,
          fingerprint: { md5Hex: 'a'.repeat(32), sha1Hex: 'b'.repeat(40), fileSize: 123 },
        },
      ],
    });
    expect(() => repeatSendPlan([{ type: 'pic', data: {} }], new Map(), true)).toThrow(
      '不能等价重发',
    );
    expect(() => repeatSendPlan([{ type: 'wallet', data: {} }], new Map(), true)).toThrow();
  });
});

describe('以唯一身份复制和重发提及', () => {
  it('HTML 剪贴板 → 昵称 → 输入框 token → 发出真 @，同名不同人不混淆', () => {
    const source = [
      plain('你好 '),
      mention('u_one', '@别人给他的备注'),
      plain(' 和 '),
      mention('u_two', '@同名'),
    ];
    const copied = mentionClipboardHtml(source)!;
    const parsed = readMentionClipboard(copied.html)!;
    const resolved = resolveMentionLabels(parsed, [
      { uid: 'u_one', nick: '公开昵称' },
      { uid: 'u_two', nick: '另一位成员' },
    ]);
    const body = elementsToComposerText(
      resolved.map((element) => ({ kind: element.type, ...element.data })),
    );
    const plan = buildComposerSendPlan({ body, locals: [], superStickers: new Map() });
    expect(plan).toMatchObject({
      kind: 'elements',
      elements: [
        { kind: 'text', textContent: '你好 ' },
        { kind: 'at', atTargetUid: 'u_one', textContent: '@公开昵称' },
        { kind: 'text', textContent: ' 和 ' },
        { kind: 'at', atTargetUid: 'u_two', textContent: '@另一位成员' },
      ],
    });
    expect(repeatSendPlan(resolved, new Map(), true)).toMatchObject(plan);
  });
  it('全体成员与未知成员保留目标；不沿用来源备注，也不按名字猜 UID', () => {
    const resolved = resolveMentionLabels(
      [mention('all', '@everyone'), mention('u_missing', '@熟悉的名字')],
      [{ uid: 'u_other', nick: '熟悉的名字' }],
    );
    expect(resolved[0]?.data?.textContent).toBe('@全体成员');
    expect(resolved[1]?.data?.textContent).toBe('@u_missing');
    expect(repeatSendPlan(resolved, new Map(), false)).toMatchObject({
      kind: 'elements',
      elements: [{ all: true, atTargetUid: 'all' }, { atTargetUid: 'u_missing' }],
    });
    expect(readMentionClipboard('<span>@只有文字</span>')).toBeNull();
    expect(
      resolveMentionLabels(
        [mention('u_one', '@旧名 '), plain('正文')],
        [{ uid: 'u_one', nick: '新名' }],
      )[0]?.data?.textContent,
    ).toBe('@新名 ');
  });
  it('旧草稿及引用中的提及按昵称重解，缺少昵称只使用号码且不改变目标', () => {
    const people = [
      { uid: 'u_one', uin: '12345', nick: '  公开昵称  ', remark: '私密备注' },
      { uid: 'u_two', uin: '23456', nick: '', remark: '另一条备注' },
    ];
    const source = [
      mention('u_one', '@私密备注 '),
      {
        type: 'reply',
        data: { origMsgSeq: 42, origElements: [mention('u_two', '@另一条备注')] },
      },
      { type: 'at', data: { atTargetUin: 12345, textContent: '@旧备注' } },
    ];
    const resolved = resolveMentionLabels(source, people);
    expect(resolved[0]?.data).toEqual({ atTargetUid: 'u_one', textContent: '@公开昵称 ' });
    expect(resolved[1]?.data).toEqual({
      origMsgSeq: 42,
      origElements: [mention('u_two', '@23456')],
    });
    expect(resolved[2]?.data).toEqual({
      atTargetUin: 12345,
      atTargetUid: 'u_one',
      textContent: '@公开昵称',
    });
    expect(source[0]?.data?.textContent).toBe('@私密备注 ');
  });
  it('发送计划中的旧提及和嵌套引用使用昵称，媒体字节和引用编号保持原样', async () => {
    const image = { kind: 'image', source: new Uint8Array([1, 2, 3]) };
    const oldMention = { kind: 'at', atTargetUid: 'u_one', textContent: '@私密备注 ' };
    const elements = [
      image,
      oldMention,
      { kind: 'reply', origMsgSeq: 42, origElements: [oldMention, image] },
    ];
    const resolved = await resolveSendMentions(elements, async (pending) =>
      resolveMentionLabels(pending, [{ uid: 'u_one', nick: '公开昵称' }]),
    );
    const expectedMention = { ...oldMention, textContent: '@公开昵称 ' };
    expect(resolved).toEqual([
      image,
      expectedMention,
      { kind: 'reply', origMsgSeq: 42, origElements: [expectedMention, image] },
    ]);
    expect(resolved[0]).toBe(image);
    expect(oldMention.textContent).toBe('@私密备注 ');
  });
  it('粘贴只恢复安全身份和文字，不执行 HTML、不加载资源', () => {
    const parsed = readMentionClipboard(
      '<script>alert(1)</script><img src="https://invalid.example/secret"><span data-weq-at-uid="u_one" onclick="alert(1)">@旧名字</span>\n正文',
    )!;
    expect(parsed).toEqual([mention('u_one', '@旧名字'), plain('\n正文')]);
  });
  it('成员列表不截成固定八人，管理员可选全体成员', () => {
    const demo = createTemplateDemoData();
    const conversation = {
      id: 'fixture',
      type: 'group',
      members: Array.from({ length: 20 }, (_, index) => ({
        ...demo.user,
        id: `u_${index}`,
        identityValue: String(index),
        role: index === 0 ? 'owner' : 'member',
      })),
    };
    const candidates = filterMentionMembers(conversation, '', 'u_0');
    expect(candidates.length).toBe(20);
    expect(candidates[0]?.id).toBe('all');
    expect(
      filterMentionMembers(conversation, '', 'u_1').some((member) => member.id === 'all'),
    ).toBe(false);
  });
});
