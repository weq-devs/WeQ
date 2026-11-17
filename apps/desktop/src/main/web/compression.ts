export function acceptsGzip(value: string): boolean {
  const weights = new Map<string, number>();
  for (const part of value.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const quality = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = quality ? Number(quality.slice(2)) : 1;
    weights.set(name ?? '', Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0);
  }
  return (weights.get('gzip') ?? weights.get('*') ?? 0) > 0;
}
