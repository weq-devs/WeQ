import type { DefaultTreeAdapterMap } from 'parse5';

export function lockRemoteViewport(head: DefaultTreeAdapterMap['element']): void {
  for (const node of head.childNodes) {
    if (!('tagName' in node) || node.tagName !== 'meta') continue;
    if (!node.attrs.some((attr) => attr.name === 'name' && attr.value === 'viewport')) continue;
    const content = node.attrs.find((attr) => attr.name === 'content');
    if (content) content.value += ', maximum-scale=1, user-scalable=no';
    return;
  }
}
