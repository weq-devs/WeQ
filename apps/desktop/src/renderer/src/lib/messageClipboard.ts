import type { RepeatElement } from './messageRepeat';
import { mentionClipboardHtml } from './mentionClipboard';

export function messageRichClipboard(
  rows: readonly {
    sender: string;
    time: string;
    body: string;
    elements?: RepeatElement[];
  }[],
): { text: string; html: string } {
  const root = document.createElement('div');
  const texts: string[] = [];
  for (const row of rows) {
    const section = document.createElement('section');
    const header = document.createElement('p');
    const name = document.createElement('strong');
    name.textContent = row.sender;
    const time = document.createElement('small');
    time.textContent = ` ${row.time}`;
    header.append(name, time);
    section.append(header);
    for (const element of row.elements ?? []) {
      if (element.type !== 'reply') continue;
      const quote = document.createElement('blockquote');
      const data = element.data ?? {};
      const original = Array.isArray(data.origElements)
        ? (data.origElements as RepeatElement[])
        : [];
      quote.textContent =
        original
          .map((item) => String(item.data?.textContent ?? item.data?.faceText ?? ''))
          .join('') || String(data.origText ?? '引用消息');
      section.append(quote);
    }
    const body = document.createElement('p');
    body.style.whiteSpace = 'pre-wrap';
    const mentions = mentionClipboardHtml(row.elements ?? []);
    if (mentions) body.innerHTML = mentions.html;
    else body.textContent = row.body;
    section.append(body);
    root.append(section);
    texts.push(`${row.sender} ${row.time}\n${row.body}`);
  }
  return { text: texts.join('\n\n'), html: root.outerHTML };
}
