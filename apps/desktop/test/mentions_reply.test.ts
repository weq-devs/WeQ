import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { elementsToComposerText } from '../src/renderer/src/im-template/template/draftElements';
import { buildComposerSendPlan } from '../src/renderer/src/im-template/template/composerSend';
import {
  getActiveComposerMentionTrigger,
  focusComposerEnd,
} from '../src/renderer/src/im-template/template/composer';

afterEach(() => {
  document.body.replaceChildren();
});

describe('提及输入与草稿往返', () => {
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
