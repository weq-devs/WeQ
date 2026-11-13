import { vi } from 'vitest';

/** 为消息渲染测试提供成功解码的资源；失败及延迟由就绪状态回归测试单独覆盖。 */
export function stubReadyDecorationResources() {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: vi.fn(), delete: vi.fn() },
  });
  vi.stubGlobal(
    'FontFace',
    class {
      async load() {
        return this;
      }
    },
  );
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      naturalWidth = 40;
      naturalHeight = 40;
      async decode() {}
      removeAttribute() {
        this.src = '';
      }
    },
  );
}
