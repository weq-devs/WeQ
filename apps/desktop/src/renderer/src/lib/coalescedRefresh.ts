/** 单个在途读取，通知只登记下一轮；等待者等到本轮合并工作结束。 */
export function createCoalescedRefresh(load: () => Promise<void>) {
  let running: Promise<void> | undefined;
  let pending = false;
  return function request(): Promise<void> {
    pending = true;
    if (running) return running;
    running = Promise.resolve().then(async () => {
      try {
        while (pending) {
          pending = false;
          await load();
          // 交付当前结果后让出事件循环，持续输入也不会饿死绘制。
          if (pending) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      } finally {
        running = undefined;
      }
    });
    return running;
  };
}
