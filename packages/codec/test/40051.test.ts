/**
 * 40051 recent-contact preview column — real markdown bot message sample.
 *
 * QQ stores the whole latest message as repeated 40051 elements. This row is
 * `[markdown, text]`: the MARKDOWN element carries the real body in tag 49099
 * while 49093(displayText) only holds the "[Markdown]" label; the trailing
 * TEXT element repeats the body in 45101 with an empty displayText. The list
 * preview must be able to recover the real text from either.
 */

import { describe, it, expect } from 'vitest';
import { ProtoMsg } from '../src/core';
import { RecentContactBody } from '../src/proto/msg/40051';
import {
  decodePreviewElement,
  ElementType,
  type MarkdownElement,
  type TextElement,
} from '../src/element';

const CONTENT = '之前有份简单的对比文档，我找找看发出来~';

/** Same real row the user pasted: {40051: markdown element}, {40051: text element}. */
const SAMPLE_HEX =
  '9ac71354d0fc150e8ae41700aafc170a5b4d61726b646f776e5ddafc173a' +
  'e4b98be5898de69c89e4bbbde7ae80e58d95e79a84e5afb9e6af94e69687e6a1a3efbc8ce68891e689bee689bee79c8be58f91e587bae69da5' +
  '7e9ac71356c8fc15b1eae7e2f7deefc86ad0fc1501ea82163a' +
  'e4b98be5898de69c89e4bbbde7ae80e58d95e79a84e5afb9e6af94e69687e6a1a3efbc8ce68891e689bee689bee79c8be58f91e587bae69da5' +
  '7ef0821600aafc1700';

function bytes(hexStr: string): Uint8Array {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('RecentContactBody (40051 preview)', () => {
  it('keeps both 40051 elements instead of merging to the last one', () => {
    const decoded = new ProtoMsg(RecentContactBody).decode(bytes(SAMPLE_HEX));
    expect(decoded.preview).toHaveLength(2);

    const [markdown, text] = decoded.preview!;
    expect(markdown!.elementType).toBe(ElementType.MARKDOWN);
    expect(markdown!.markdownContent49099).toBe(CONTENT);
    expect(markdown!.displayText).toBe('[Markdown]');

    expect(text!.elementType).toBe(ElementType.TEXT);
    expect(text!.textContent).toBe(CONTENT);
    expect(text!.displayText).toBe('');
  });

  it('decodes to markdown / text preview elements with the real body', () => {
    const decoded = new ProtoMsg(RecentContactBody).decode(bytes(SAMPLE_HEX));
    const elements = decoded.preview!.map((wire) => decodePreviewElement(wire));

    const markdown = elements.find((el) => el.kind === 'markdown') as MarkdownElement | undefined;
    expect(markdown).toBeDefined();
    expect(markdown!.markdownContent49099).toBe(CONTENT);

    const text = elements.find((el) => el.kind === 'text') as TextElement | undefined;
    expect(text).toBeDefined();
    expect(text!.textContent).toBe(CONTENT);
  });
});
