export function messageNotificationDedupe(limit = 5000) {
  const seen = new Set<string>();
  const identity = (configId: string, kind: string, conv: string, seq: string) =>
    JSON.stringify([configId, kind, conv, seq]);
  const claim = (configId: string, kind: string, conv: string, seq: string) => {
    const key = identity(configId, kind, conv, seq);
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > limit) seen.delete(seen.values().next().value!);
    return true;
  };
  return Object.assign(claim, {
    release: (configId: string, kind: string, conv: string, seq: string) =>
      seen.delete(identity(configId, kind, conv, seq)),
  });
}
