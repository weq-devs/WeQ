// @ts-nocheck
export async function copyTextToClipboard(value: string, ownerDocument: Document = document) {
  const text = value.trimEnd();
  if (!text) {
    return false;
  }

  if (copyTextWithTextarea(text, ownerDocument)) {
    return true;
  }

  try {
    const clipboard = (ownerDocument.defaultView?.navigator ?? navigator).clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard writes can be blocked when the page is not focused or not secure.
  }

  return false;
}

function copyTextWithTextarea(text: string, document: Document) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.width = '1px';
  textarea.style.height = '1px';
  textarea.style.opacity = '0';
  textarea.style.fontSize = '16px';
  textarea.style.setProperty('-webkit-user-select', 'text');
  textarea.style.userSelect = 'text';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
