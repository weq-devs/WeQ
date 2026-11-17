export const DROP_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'embed',
  'svg',
  'math',
  'template',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
]);

export function collectionContentText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const tag of DROP_TAGS) {
    for (const element of doc.querySelectorAll(tag)) element.remove();
  }
  for (const element of doc.querySelectorAll('br')) element.replaceWith('\n');
  for (const element of doc.querySelectorAll('p, div, li')) element.append('\n');
  return (doc.body.textContent ?? '').trim();
}
