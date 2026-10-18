import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

const OMIT = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'iframe',
  'object',
  'svg',
  'math',
]);
const BREAK = new Set([
  'p',
  'div',
  'li',
  'tr',
  'br',
  'hr',
  'blockquote',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
]);

/** 仅提取正文文字，不检索标签、资源地址或脚本，也不加载任何外部资源。 */
export function htmlPlainText(html: string): string {
  const output: string[] = [];
  const visit = (node: DefaultTreeAdapterMap['node'], depth: number): void => {
    if (depth > 128) return;
    if ('value' in node && node.nodeName === '#text') output.push(node.value);
    if ('tagName' in node) {
      if (
        OMIT.has(node.tagName) ||
        node.attrs.some(
          (attr) =>
            attr.name === 'hidden' || (attr.name === 'aria-hidden' && attr.value === 'true'),
        )
      )
        return;
      if (BREAK.has(node.tagName)) output.push('\n');
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child, depth + 1);
    if ('tagName' in node && BREAK.has(node.tagName)) output.push('\n');
  };
  visit(parseFragment(html), 0);
  return output
    .join('')
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}
