import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadMessageElementPatches,
  saveMessageElementPatches,
} from '../src/renderer/src/lib/messageElementPatchStore';

/** 最小可用的 sessionStorage 替身（测试环境不一定有 DOM）。 */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  });
  return store;
}

const CONV = 'account:source:peer';
const FLASH_ELEMENTS = [
  { type: 'pic', data: { isFlash: true, fileToken: '/2863253201-1-ABC', fileName: 'a.jpg' } },
];

describe('特殊消息元素的会话级缓存', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installStorage();
  });

  it('没有记录时返回空状态', () => {
    expect(loadMessageElementPatches(CONV)).toEqual({ patches: {}, dead: [] });
  });

  it('写入后能原样读回（元素内容不丢）', () => {
    saveMessageElementPatches(CONV, {
      patches: { '7702493945254447733': { elements: FLASH_ELEMENTS, sourceFormat: 'protocol' } },
      dead: ['7701528742247242864'],
    });
    const restored = loadMessageElementPatches(CONV);
    expect(restored.patches['7702493945254447733']!.elements).toEqual(FLASH_ELEMENTS);
    expect(restored.patches['7702493945254447733']!.sourceFormat).toBe('protocol');
    expect(restored.dead).toEqual(['7701528742247242864']);
  });

  it('账号数据源互不干扰', () => {
    saveMessageElementPatches(CONV, { patches: { a: { elements: FLASH_ELEMENTS } }, dead: [] });
    saveMessageElementPatches('account:other-source:peer', {
      patches: { b: { elements: FLASH_ELEMENTS } },
      dead: [],
    });
    expect(Object.keys(loadMessageElementPatches(CONV).patches)).toEqual(['a']);
    expect(Object.keys(loadMessageElementPatches('account:other-source:peer').patches)).toEqual([
      'b',
    ]);
  });

  it('存的是坏数据时按空处理，不能污染时间线', () => {
    sessionStorage.setItem('weq.message-elements.v1.bad', '{not json');
    expect(loadMessageElementPatches('bad')).toEqual({ patches: {}, dead: [] });

    sessionStorage.setItem(
      'weq.message-elements.v1.shape',
      JSON.stringify({ patches: { x: { elements: 'nope' }, y: { elements: [] } }, dead: [1, 'z'] }),
    );
    const restored = loadMessageElementPatches('shape');
    // 元素不是数组的丢掉；dead 里的非字符串也丢掉。
    expect(Object.keys(restored.patches)).toEqual(['y']);
    expect(restored.dead).toEqual(['z']);
  });

  it('空的会话号直接跳过，不写空键', () => {
    saveMessageElementPatches('', { patches: {}, dead: [] });
    expect(loadMessageElementPatches('')).toEqual({ patches: {}, dead: [] });
  });

  it('sessionStorage 不可用时静默降级（不能让渲染崩）', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    });
    expect(() => saveMessageElementPatches(CONV, { patches: {}, dead: [] })).not.toThrow();
    expect(loadMessageElementPatches(CONV)).toEqual({ patches: {}, dead: [] });
  });
});
