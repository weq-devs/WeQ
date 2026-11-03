// @vitest-environment node
import superjson from 'superjson';
import { describe, expect, it } from 'vitest';
import { elementsFromEditable, elementsToEditable } from '../src/main/ipc/serde';

/**
 * IPC 边界的字节还原。
 *
 * 渲染层发送图片 / 语音时直接给 `Uint8Array`，superjson 的 typed-array 规则会把它
 * 原样带过 IPC；主进程再用 `elementsFromEditable` 还原。这里锁住「已经是
 * Uint8Array 的值必须原样保留」——否则会被当成普通对象逐键拷贝成
 * `{0:..,1:..}`，调用方只看到 byteLength 丢失，一律报「图片为空」。
 */
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('elementsFromEditable', () => {
  it('保留 superjson 还原出来的 Uint8Array', () => {
    const overIpc = superjson.deserialize(superjson.serialize(png)) as Uint8Array;
    const restored = elementsFromEditable(overIpc) as Uint8Array;
    expect(restored).toBeInstanceOf(Uint8Array);
    expect(restored.byteLength).toBe(png.byteLength);
    expect(Array.from(restored)).toEqual(Array.from(png));
  });

  it('保留嵌套在入参对象 / 数组里的 Uint8Array', () => {
    const input = superjson.deserialize(superjson.serialize({ source: png, list: [png] })) as {
      source: Uint8Array;
      list: Uint8Array[];
    };
    const restored = elementsFromEditable(input);
    expect(restored.source).toBeInstanceOf(Uint8Array);
    expect(restored.source.byteLength).toBe(png.byteLength);
    expect(restored.list[0]).toBeInstanceOf(Uint8Array);
    expect(restored.list[0].byteLength).toBe(png.byteLength);
  });

  it('仍然还原 `{ type: "Buffer", data }` 盒子', () => {
    const restored = elementsFromEditable({
      source: { type: 'Buffer', data: Array.from(png) },
    }).source as Uint8Array;
    expect(restored).toBeInstanceOf(Uint8Array);
    expect(Array.from(restored)).toEqual(Array.from(png));
  });

  it('与 elementsToEditable 互为逆变换', () => {
    const boxed = elementsToEditable({ source: png });
    expect(boxed.source).toEqual({ type: 'Buffer', data: Array.from(png) });
    const restored = elementsFromEditable(boxed).source as Uint8Array;
    expect(restored).toBeInstanceOf(Uint8Array);
    expect(Array.from(restored)).toEqual(Array.from(png));
  });
});
