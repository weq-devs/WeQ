import { openLink, splitLinks } from '../../src/renderer/src/lib/linkify';
import '../../src/renderer/src/styles/index.css';

const cases = [
  { id: 'bare', text: '看这里：h3cof6.com，或“example.com/path”。' },
  { id: 'full', text: 'http://whatisthis.h3cof6.com' },
  { id: 'query', text: 'sub.h3cof6.com/path?q=weq#chat' },
  { id: 'www', text: 'www.h3cof6.com' },
  { id: 'email', text: 'user@h3cof6.com mailto:user@h3cof6.com' },
  { id: 'version', text: '2.7.0 v2.7.0 192.168.1.1' },
  { id: 'filename', text: 'main.ts package.json report.pdf image.png README.md' },
];

const style = document.createElement('style');
style.textContent = `
  html, body { margin: 0; color: var(--foreground); background: var(--background); font-family: system-ui; }
  * { box-sizing: border-box; }
  main { width: min(100%, 720px); margin: 0 auto; padding: 20px; }
  .message-line { padding: 14px 0; border-bottom: 1px solid var(--border); }
  .message-content { font-size: 15px; line-height: 1.65; overflow-wrap: anywhere; }
  .qq-link { white-space: normal; text-align: left; overflow-wrap: anywhere; }
`;
document.head.append(style);

window.open = (...args) => {
  document.documentElement.dataset.lastOpened = JSON.stringify(args);
  return null;
};

const root = document.getElementById('root')!;
for (const item of cases) {
  const row = document.createElement('section');
  row.className = 'message-line';
  row.dataset.case = item.id;
  const content = document.createElement('span');
  content.className = 'message-content';
  for (const part of splitLinks(item.text)) {
    if (part.kind === 'text') content.append(document.createTextNode(part.text));
    else {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'qq-link';
      link.title = part.href;
      link.textContent = part.text;
      link.addEventListener('click', () => openLink(part.href));
      content.append(link);
    }
  }
  row.append(content);
  root.append(row);
}
document.documentElement.dataset.ready = 'true';
