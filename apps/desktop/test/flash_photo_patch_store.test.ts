/**
 * 闪照补拉结果的会话级缓存。
 *
 * 背景：补丁只放 React state 时，切走会话就丢了，切回来要重新发包——而重试名额
 * 一起清零，表现就是「第一次能看到，切一下就没了」。所以按会话号存 sessionStorage。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadFlashPhotoState,
  saveFlashPhotoState,
} from '../src/renderer/src/lib/flashPhotoPatchStore';

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

const CONV = 'u_LKt3AdAIMP-CUfn6ydzDzw';
const FLASH_ELEMENTS = [
  { type: 'pic', data: { isFlash: true, fileToken: '/2863253201-1-ABC', fileName: 'a.jpg' } },
];

describe('闪照补丁的会话级缓存', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installStorage();
  });

  it('没有记录时返回空状态', () => {
    expect(loadFlashPhotoState(CONV)).toEqual({ patches: {}, dead: [] });
  });

  it('写入后能原样读回（元素内容不丢）', () => {
    saveFlashPhotoState(CONV, {
      patches: { '7702493945254447733': { elements: FLASH_ELEMENTS, sourceFormat: 'protocol' } },
      dead: ['7701528742247242864'],
    });
    const restored = loadFlashPhotoState(CONV);
    expect(restored.patches['7702493945254447733']!.elements).toEqual(FLASH_ELEMENTS);
    expect(restored.patches['7702493945254447733']!.sourceFormat).toBe('protocol');
    expect(restored.dead).toEqual(['7701528742247242864']);
  });

  it('不同会话互不干扰', () => {
    saveFlashPhotoState(CONV, { patches: { a: { elements: FLASH_ELEMENTS } }, dead: [] });
    saveFlashPhotoState('group:123', { patches: { b: { elements: FLASH_ELEMENTS } }, dead: [] });
    expect(Object.keys(loadFlashPhotoState(CONV).patches)).toEqual(['a']);
    expect(Object.keys(loadFlashPhotoState('group:123').patches)).toEqual(['b']);
  });

  it('存的是坏数据时按空处理，不能污染时间线', () => {
    sessionStorage.setItem('weq.flash-photo.v1.bad', '{not json');
    expect(loadFlashPhotoState('bad')).toEqual({ patches: {}, dead: [] });

    sessionStorage.setItem(
      'weq.flash-photo.v1.shape',
      JSON.stringify({ patches: { x: { elements: 'nope' }, y: { elements: [] } }, dead: [1, 'z'] }),
    );
    const restored = loadFlashPhotoState('shape');
    // 元素不是数组的丢掉；dead 里的非字符串也丢掉。
    expect(Object.keys(restored.patches)).toEqual(['y']);
    expect(restored.dead).toEqual(['z']);
  });

  it('空的会话号直接跳过，不写空键', () => {
    saveFlashPhotoState('', { patches: {}, dead: [] });
    expect(loadFlashPhotoState('')).toEqual({ patches: {}, dead: [] });
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
    expect(() => saveFlashPhotoState(CONV, { patches: {}, dead: [] })).not.toThrow();
    expect(loadFlashPhotoState(CONV)).toEqual({ patches: {}, dead: [] });
  });
});
