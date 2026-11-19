import { act } from 'react';
import { flushSync } from 'react-dom';

export const formSelectSelector = 'button[role="combobox"]';

function openOptions(trigger: HTMLButtonElement) {
  if (trigger.getAttribute('aria-expanded') !== 'true') flushSync(() => trigger.click());
  const id = trigger.getAttribute('aria-controls');
  const list = id && trigger.ownerDocument.getElementById(id);
  if (!list) throw new Error(`未打开选项：${trigger.getAttribute('aria-label')}`);
  return [...list.querySelectorAll<HTMLElement>('[role="option"]')];
}

export function chooseFormOption(trigger: HTMLButtonElement, value: string) {
  if (trigger.disabled) return;
  const option = openOptions(trigger).find((row) => row.dataset.value === value);
  if (!option || option.getAttribute('aria-disabled') === 'true') {
    throw new Error(`选项不可用：${value}`);
  }
  option.click();
}

export function formOptions(trigger: HTMLButtonElement) {
  const read = () =>
    openOptions(trigger).map((row) => ({
      value: row.dataset.value,
      textContent: row.textContent,
    }));
  let options: ReturnType<typeof read> = [];
  act(() => {
    options = read();
    flushSync(() => trigger.click());
  });
  return options;
}

export function changeInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function chooseCalendarDate(trigger: HTMLButtonElement, value: string) {
  flushSync(() => trigger.click());
  const input = trigger.ownerDocument.querySelector<HTMLInputElement>(
    'input[aria-label="输入日期（年-月-日）"]',
  )!;
  flushSync(() => changeInput(input, value));
  input.form!.querySelector<HTMLButtonElement>('[type="submit"]')!.click();
}
