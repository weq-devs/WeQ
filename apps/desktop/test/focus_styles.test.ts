// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function rules(file: string) {
  const style = document.createElement('style');
  style.textContent = readFileSync(`src/renderer/src/styles/${file}.css`, 'utf8');
  document.head.append(style);
  const rules = Array.from(style.sheet!.cssRules).filter(
    (rule): rule is CSSStyleRule => 'selectorText' in rule,
  );
  style.remove();
  return rules;
}

describe('控件焦点样式', () => {
  it('指针模式隐藏长按目标外圈，Tab 模式和原生编辑控件不受影响', () => {
    const rule = rules('form-focus').find((rule) =>
      rule.selectorText.includes("data-weq-input-modality='pointer'"),
    )!;
    const html = document.documentElement;
    html.dataset.theme = 'dark';
    html.dataset.weqInputModality = 'pointer';
    const host = document.createElement('div');
    document.body.append(host);
    try {
      const selector = rule.selectorText.replaceAll(':focus', '[data-test-focus]');
      for (const markup of [
        '<button data-test-focus></button>',
        '<span role="button" data-test-focus></span>',
        '<input type="submit" data-test-focus>',
        '<a href="#" data-test-focus></a>',
        '<summary data-test-focus></summary>',
        '<div tabindex="0" data-weq-select-id="message" data-test-focus></div>',
        '<div tabindex="-1" data-weq-multi-group data-test-focus></div>',
        '<span role="tab" data-test-focus></span>',
        '<span role="menuitem" data-test-focus></span>',
      ]) {
        host.innerHTML = markup;
        expect(host.firstElementChild!.matches(selector), markup).toBe(true);
        html.dataset.weqInputModality = 'keyboard';
        expect(host.firstElementChild!.matches(selector), markup).toBe(false);
        html.dataset.weqInputModality = 'pointer';
      }
      for (const type of ['text', 'checkbox', 'radio', 'range', 'color', 'file']) {
        host.innerHTML = `<input type="${type}" tabindex="0" data-test-focus>`;
        expect(host.firstElementChild!.matches(selector), type).toBe(false);
      }
      for (const markup of [
        '<textarea tabindex="0" data-test-focus></textarea>',
        '<select tabindex="0" data-test-focus></select>',
        '<div contenteditable="true" tabindex="0" data-test-focus></div>',
      ]) {
        host.innerHTML = markup;
        expect(host.firstElementChild!.matches(selector), markup).toBe(false);
      }
      expect(rule.style.outline).toBe('none');
      expect(rule.style.getPropertyValue('box-shadow')).toBe('');
      expect(rule.style.getPropertyValue('border')).toBe('');
    } finally {
      host.remove();
      delete html.dataset.theme;
      delete html.dataset.weqInputModality;
    }
  });

  it('文本焦点统一去掉外圈，但不覆盖原生非文本控件', () => {
    const rule = rules('form-focus').find(
      (rule) =>
        rule.style.outline === 'none' &&
        rule.selectorText.includes('textarea') &&
        !rule.selectorText.includes('data-weq-input-modality'),
    )!;
    document.documentElement.dataset.theme = 'light';
    const host = document.createElement('div');
    document.body.append(host);
    try {
      // 只替换状态伪类，保留真实类型和作用域选择器做匹配。
      const selector = rule.selectorText
        .replaceAll(':focus-visible', '[data-test-focus]')
        .replaceAll(':focus', '[data-test-focus]');
      for (const type of ['text', 'search', 'password', 'number', 'email']) {
        host.innerHTML = `<input type="${type}" data-test-focus>`;
        expect(host.firstElementChild!.matches(selector), type).toBe(true);
      }
      for (const type of ['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit']) {
        host.innerHTML = `<input type="${type}" data-test-focus>`;
        expect(host.firstElementChild!.matches(selector), type).toBe(false);
      }
      expect(rule.style.getPropertyValue('box-shadow')).toBe('none');
    } finally {
      host.remove();
      delete document.documentElement.dataset.theme;
    }
  });

  it.each(['profile-avatar', 'common-relationships', 'contact-notices', 'conversation-actions'])(
    '%s 的悬停状态不再绘制选中外框，键盘焦点仍有提示',
    (file) => {
      const styles = rules(file);
      for (const rule of styles.filter((rule) => rule.selectorText.includes(':hover'))) {
        expect(rule.style.getPropertyValue('outline'), rule.selectorText).toBe('');
      }
      expect(
        styles.some((rule) => rule.selectorText.includes(':focus-visible') && rule.style.outline),
      ).toBe(true);
    },
  );

  it.each(['clone-group-members', 'group-album-browser', 'page-chrome', 'favorite-emoji-import'])(
    '%s 的输入容器不再叠加焦点外框',
    (file) => {
      for (const rule of rules(file).filter((rule) =>
        rule.selectorText.includes(':focus-within'),
      )) {
        expect(rule.style.getPropertyValue('outline'), rule.selectorText).toBe('');
      }
    },
  );

  it('非经典风格不再单独给文本输入框加焦点外框', () => {
    const focused = rules('component-appearance').filter((rule) =>
      rule.selectorText.includes(':focus-visible'),
    );
    expect(focused.length).toBeGreaterThan(0);
    for (const rule of focused) {
      expect(rule.selectorText).not.toMatch(
        /\.weq-(?:input|set-input|set-select|directory-toolbar input)\b/,
      );
    }
  });
});
