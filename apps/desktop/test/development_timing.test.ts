import { afterEach, expect, it, vi } from 'vitest';
import {
  DEVELOPMENT_TIMING_ENTRY_LIMIT,
  REACT_COMPONENT_MEASURE_PREFIX,
  installDevelopmentTiming,
} from '../src/renderer/src/lib/developmentTiming';

let stop = () => {};
afterEach(() => {
  stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  const observers: TestObserver[] = [];
  class TestObserver {
    static supportedEntryTypes = ['measure'];
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(private callback: PerformanceObserverCallback) {
      observers.push(this);
    }
    emit(names: string[]) {
      const entries = names.map((name) =>
        Object.defineProperty({ name, entryType: 'measure' }, 'detail', {
          get() {
            throw new Error('不能读取 props 明细');
          },
        }),
      );
      this.callback(
        { getEntries: () => entries } as PerformanceObserverEntryList,
        this as unknown as PerformanceObserver,
        {},
      );
    }
  }
  vi.stubGlobal('PerformanceObserver', TestObserver);
  const clear = vi.spyOn(window.performance, 'clearMeasures');
  return { observers, clear };
}

it('开发组件记录按批次限量，正常性能条目不受影响，也不读取 detail', () => {
  const { observers, clear } = fixture();
  stop = installDevelopmentTiming(window, true);
  const observer = observers[0]!;
  expect(observer.observe).toHaveBeenCalledWith({ type: 'measure', buffered: true });
  observer.emit([
    'weq:message-query',
    ...Array(DEVELOPMENT_TIMING_ENTRY_LIMIT - 1).fill(`${REACT_COMPONENT_MEASURE_PREFIX}List`),
  ]);
  expect(clear).not.toHaveBeenCalled();
  observer.emit([`${REACT_COMPONENT_MEASURE_PREFIX}Row`]);
  expect(clear.mock.calls).toEqual([
    [`${REACT_COMPONENT_MEASURE_PREFIX}List`],
    [`${REACT_COMPONENT_MEASURE_PREFIX}Row`],
  ]);
  clear.mockClear();
  observer.emit(['weq:message-query']);
  expect(clear).not.toHaveBeenCalled();
});

it('首次安装同时清理已缓冲的开发条目，不因一个大批次遗漏名称', () => {
  const { observers, clear } = fixture();
  stop = installDevelopmentTiming(window, true);
  observers[0]!.emit(
    Array.from(
      { length: DEVELOPMENT_TIMING_ENTRY_LIMIT * 3 },
      (_, i) => `${REACT_COMPONENT_MEASURE_PREFIX}Component${i}`,
    ),
  );
  expect(clear).toHaveBeenCalledTimes(DEVELOPMENT_TIMING_ENTRY_LIMIT * 3);
});

it('卸载和重装释放观察器及剩余开发记录，旧回调不影响新安装', () => {
  const { observers, clear } = fixture();
  stop = installDevelopmentTiming(window, true);
  observers[0]!.emit([`${REACT_COMPONENT_MEASURE_PREFIX}Old`]);
  stop = installDevelopmentTiming(window, true);
  expect(observers[0]!.disconnect).toHaveBeenCalledTimes(1);
  expect(clear).toHaveBeenCalledWith(`${REACT_COMPONENT_MEASURE_PREFIX}Old`);
  clear.mockClear();
  observers[0]!.emit(
    Array(DEVELOPMENT_TIMING_ENTRY_LIMIT).fill(`${REACT_COMPONENT_MEASURE_PREFIX}Stale`),
  );
  expect(clear).not.toHaveBeenCalled();
  observers[1]!.emit([`${REACT_COMPONENT_MEASURE_PREFIX}Current`]);
  stop();
  expect(clear).toHaveBeenCalledWith(`${REACT_COMPONENT_MEASURE_PREFIX}Current`);
});

it('正式构建或不支持 measure 观察时不安装、不清理应用条目', () => {
  const { observers, clear } = fixture();
  stop = installDevelopmentTiming(window, false);
  expect(observers).toHaveLength(0);
  expect(clear).not.toHaveBeenCalled();
  vi.stubGlobal('PerformanceObserver', undefined);
  stop = installDevelopmentTiming(window, true);
  expect(clear).not.toHaveBeenCalled();
});
