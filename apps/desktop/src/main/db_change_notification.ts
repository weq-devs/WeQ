/** 合并一小段时间内的变化，持续写库也不推迟首轮；销毁后不再投递。 */
export function createDbChangeNotification<T>(emit: (value: T) => void, delayMs = 200) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: { value: T } | undefined;
  let disposed = false;
  return {
    request(value: T) {
      if (disposed) return;
      latest = { value };
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        const pending = latest;
        latest = undefined;
        if (pending && !disposed) emit(pending.value);
      }, delayMs);
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      latest = undefined;
    },
  };
}
