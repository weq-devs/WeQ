/** 合并数据库通知；执行中只补一轮，失败退避，销毁后不再启动查询。 */
export function createUnreadRefresh(load: () => Promise<boolean>, delayMs = 100) {
  let disposed = false;
  let running = false;
  let pending = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (delay: number) => {
    if (disposed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delay);
  };

  async function run() {
    if (disposed) return;
    running = true;
    pending = false;
    let succeeded = false;
    try {
      succeeded = await load();
    } catch {
      // 调用方保留旧状态；没有后续文件变化时也必须自行重试。
    } finally {
      running = false;
      failures = succeeded ? 0 : Math.min(failures + 1, 6);
      if (!disposed && (!succeeded || pending)) {
        arm(succeeded ? delayMs : Math.min(1000 * 2 ** (failures - 1), 30000));
      }
    }
  }

  return {
    request() {
      if (disposed) return;
      pending = true;
      if (!running) arm(failures > 0 ? Math.min(1000 * 2 ** (failures - 1), 30000) : delayMs);
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** 重试固定水位的已读请求；换号、换会话或隐藏后不再发出下一次请求。 */
export async function retryConversationRead<T>(
  write: () => Promise<T>,
  isCurrent: () => boolean,
): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!isCurrent()) return null;
    try {
      return await write();
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 150 : 450));
    }
  }
  return null;
}
