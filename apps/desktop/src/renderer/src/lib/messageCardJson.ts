import type { Message } from '../im-template/template/types';

export function messageCardJson(elements: NonNullable<Message['qqElements']>): string {
  const element = elements[0];
  const ark = element?.type === 'ark' ? element.data?.arkData : null;
  if (typeof ark === 'string') {
    try {
      JSON.parse(ark);
      return ark;
    } catch {
      // 不是有效 JSON 的旧卡片用原元素包裹，保留原始值。
    }
  }
  return JSON.stringify(
    ark && typeof ark === 'object' ? ark : elements.length === 1 ? element : elements,
    null,
    2,
  );
}
