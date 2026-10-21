import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { elementsToComposerText } from '../src/renderer/src/im-template/template/draftElements';
import { buildComposerSendPlan } from '../src/renderer/src/im-template/template/composerSend';
import { mentionText } from '../src/renderer/src/im-template/template/mentions';
import {
  getActiveComposerMentionTrigger,
  focusComposerEnd,
} from '../src/renderer/src/im-template/template/composer';

afterEach(() => {
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
