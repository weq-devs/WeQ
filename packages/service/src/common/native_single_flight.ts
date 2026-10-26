/** 只合并同一原生实例的在途读取，不延长凭据有效期，也不保留完成结果。 */
export function createNativeSingleFlight<T>() {
  const owners = new WeakMap<object, Map<string, Promise<T>>>();
  return {
    run(owner: object, key: string, read: () => Promise<T>): Promise<T> {
      let requests = owners.get(owner);
      if (!requests) {
        requests = new Map();
        owners.set(owner, requests);
      }
      const existing = requests.get(key);
      if (existing) return existing;
      const active = requests;
      const task = (async () => read())().finally(() => {
        if (active.get(key) === task) active.delete(key);
      });
      active.set(key, task);
      return task;
    },
    forget(owner: object, key: string): void {
      owners.get(owner)?.delete(key);
    },
  };
}
