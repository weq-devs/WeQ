import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { elementsToComposerText } from '../src/renderer/src/im-template/template/draftElements';
import { buildComposerSendPlan } from '../src/renderer/src/im-template/template/composerSend';
import { mentionText } from '../src/renderer/src/im-template/template/mentions';
import {
  getActiveComposerMentionTrigger,
  focusComposerEnd,
  insertComposerNode,
  replaceComposerTextRange,
  restoreComposer,
  serializeComposer,
} from '../src/renderer/src/im-template/template/composer.shared';

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe('提及输入与草稿往返', () => {
  it('提及文本只用昵称，不用群名片或好友备注；无昵称时退回号码或 UID', () => {
    const member = {
      id: 'u_fixture',
      username: 'u_fixture',
      identityValue: '12345',
      displayName: '私密备注',
      card: '群名片',
      remark: '私密备注',
      nick: '公开昵称',
    };
    expect(mentionText(member)).toBe('@公开昵称');
    expect(mentionText({ ...member, nick: '' })).toBe('@12345');
    expect(mentionText({ ...member, nick: '', identityValue: '' })).toBe('@u_fixture');
    expect(mentionText({ ...member, id: 'all' })).toBe('@全体成员');
  });
  it('恢复普通提及与全体提及，不退化为纯文字，保留左右正文', () => {
    const elements = [
      { kind: 'text', textContent: '你好 ' },
      { kind: 'at', atTargetUid: 'u_fixture', textContent: '@测试成员' },
      { kind: 'text', textContent: ' 和 ' },
      { kind: 'at', atTargetUid: 'all', all: true, textContent: '@全体成员' },
    ];
    const body = elementsToComposerText(elements);
    expect(buildComposerSendPlan({ body, locals: [], superStickers: new Map() })).toEqual({
      kind: 'elements',
      elements,
    });
  });
  it.each(['你好@测', '你好，@测', '@测', '前文\n@测'])('在 %s 的光标位置触发成员选择', (text) => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.textContent = text;
    document.body.append(editor);
    focusComposerEnd(editor);
    expect(getActiveComposerMentionTrigger(editor, null)).toEqual({
      start: text.indexOf('@'),
      end: text.length,
      query: '测',
    });
  });
  it('邮箱不触发成员选择', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.textContent = 'person@example';
    document.body.append(editor);
    focusComposerEnd(editor);
    expect(getActiveComposerMentionTrigger(editor, null)).toBeNull();
  });
  it.each([false, true])('连续提及多人只替换当前触发词，保留真实目标；使用保存选区=%s', (saved) => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    document.body.append(editor);
    const mentions = [
      { kind: 'at', atTargetUid: 'u_first', textContent: '@第一位成员' },
      { kind: 'at', atTargetUid: 'u_second', textContent: '@第二位成员' },
      { kind: 'at', atTargetUid: 'all', all: true, textContent: '@全体成员' },
    ];
    const expected = [];
    for (const [index, mention] of mentions.entries()) {
      insertComposerNode(editor, document.createTextNode(index === 1 ? '@第二' : '@'), null);
      const savedRange = window.getSelection()!.getRangeAt(0).cloneRange();
      if (saved) window.getSelection()!.removeAllRanges();
      const trigger = getActiveComposerMentionTrigger(editor, savedRange)!;
      expect(trigger).not.toBeNull();
      const holder = document.createElement('div');
      restoreComposer(holder, elementsToComposerText([mention]));
      replaceComposerTextRange(editor, trigger.start, trigger.end, [
        ...holder.childNodes,
        document.createTextNode(' '),
      ]);
      expected.push(mention, { kind: 'text', textContent: ' ' });
      expect(editor.textContent).toBe(
        mentions
          .slice(0, index + 1)
          .map((item) => `${item.textContent} `)
          .join(''),
      );
      expect(
        buildComposerSendPlan({
          body: serializeComposer(editor),
          locals: [],
          superStickers: new Map(),
        }),
      ).toEqual({ kind: 'elements', elements: expected });
    }
  });
  it.each([
    { kind: 'at', atTargetUid: 'u_first', textContent: '@第一位成员' },
    { kind: 'file', fileName: 'fixture.txt', fileUuid: 'synthetic-file' },
    { kind: 'pic', fileName: 'fixture.png', localPreviewUrl: 'data:image/png;base64,AA==' },
  ])('在 $kind 元素之后的正文中插入提及，不残留 @ 或删除前后文', (prefix) => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    document.body.append(editor);
    restoreComposer(
      editor,
      elementsToComposerText([prefix, { kind: 'text', textContent: ' 前文 @查 后文' }]),
    );
    const range = document.createRange();
    range.setStart(editor.lastChild!, ' 前文 @查'.length);
    range.collapse(true);
    window.getSelection()!.addRange(range);
    const trigger = getActiveComposerMentionTrigger(editor, null)!;
    expect(trigger?.query).toBe('查');
    const mention = { kind: 'at', atTargetUid: 'u_next', textContent: '@下一位成员' };
    const holder = document.createElement('div');
    restoreComposer(holder, elementsToComposerText([mention]));
    replaceComposerTextRange(editor, trigger.start, trigger.end, [...holder.childNodes]);
    expect(serializeComposer(editor)).toBe(
      elementsToComposerText([
        prefix,
        { kind: 'text', textContent: ' 前文 ' },
        mention,
        { kind: 'text', textContent: ' 后文' },
      ]),
    );
  });
});

describe('引用框在装扮气泡中的可读性', () => {
  it('引用条不继承消息气泡的装扮字体，固定回正文字体', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(
      resolve(__dirname, '../src/renderer/src/im-template/styles/chat.css'),
      'utf8',
    );
    document.head.append(style);
    document.body.innerHTML =
      '<div class="message-line mine"><div class="message-content qq-has-reply" style="font-family: weq-dress-123, sans-serif"><div class="qq-reply-quote">被引用内容</div></div></div>';
    try {
      // 气泡上挂着装扮字体（dressSkin / msgDecorationStyle 注入的 font-family），
      // 引用条必须把它甩掉 —— 子集化字体在这里缺字、炫彩字也会和正文抢戏。
      expect(
        window.getComputedStyle(document.querySelector('.qq-reply-quote')!).fontFamily,
      ).not.toContain('weq-dress-123');
    } finally {
      style.remove();
    }
  });
  it('我方浅色装扮气泡的引用沿用气泡文字颜色，不固定为白色', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(
      resolve(__dirname, '../src/renderer/src/im-template/styles/chat.css'),
      'utf8',
    );
    document.head.append(style);
    document.body.innerHTML =
      '<div class="message-line mine"><div class="message-content qq-has-reply" style="color:rgb(80, 90, 130)"><div class="qq-reply-quote">被引用内容</div></div></div>';
    try {
      expect(window.getComputedStyle(document.querySelector('.qq-reply-quote')!).color).toBe(
        'rgb(80, 90, 130)',
      );
    } finally {
      style.remove();
    }
  });
});
