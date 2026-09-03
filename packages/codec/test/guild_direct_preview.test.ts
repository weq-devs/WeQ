/**
 * Guild DM list preview column (`direct_node_list_table.40051`) - real row.
 *
 * The guild cache wraps the latest message in an envelope: each top-level
 * 40051 is a message record whose own repeated 40051 holds the preview
 * element. This row is an animated-sticker message, so the recovered element
 * is a PIC carrying only displayText "[动画表情]".
 */

import { describe, expect, it } from 'vitest';
import { ProtoMsg } from '../src/core';
import { decodePreviewElement, ElementType } from '../src/element';
import { sanitizeBytes } from '../src/raw';
import { DirectNodePreviewBody } from '../src/proto/guild/direct_preview';

const SAMPLE_HEX =
  '9ac7138201d8c41302a2c51312313434313135323138373331393339363832' +
  'aac513113132303032353231373836363331393437b2c5131136343038313035' +
  '31373836363331393437c8c6130290c713eab1f7d3069ac7131ad0fc1502d8fc' +
  '1501aafc170e5be58aa8e794bbe8a1a8e683855dd2c913064833436f4636ea' +
  'c913064833436f4636';

function bytes(hexStr: string): Uint8Array {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('Guild direct preview (direct_node_list_table.40051)', () => {
  it('decodes the envelope-wrapped element instead of an empty unknown', () => {
    const codec = new ProtoMsg(DirectNodePreviewBody);
    const decoded = codec.decode(sanitizeBytes(bytes(SAMPLE_HEX), DirectNodePreviewBody));
    const nodes = decoded.nodes ?? [];
    expect(nodes).toHaveLength(1);
    const elements = nodes[0]?.elements ?? [];
    expect(elements).toHaveLength(1);
    expect(elements[0]?.elementType).toBe(ElementType.PIC);
    const el = decodePreviewElement(elements[0]!);
    expect(el.displayText).toBe('[动画表情]');
  });
});
