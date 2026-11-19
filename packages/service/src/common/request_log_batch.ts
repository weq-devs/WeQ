export const REQUEST_LOG_WINDOW_MS = 60_000;
export const REQUEST_LOG_BATCH_THRESHOLD = 10;
const MAX_GROUPS = 1024;

interface RequestTiming {
  scope: string;
  path: string;
  type: string;
  durationMs: number;
}

interface Group {
  request: RequestTiming;
  count: number;
  min: number;
  max: number;
  sum: number;
  details: (() => void)[];
}

export interface RequestLogSummary extends Omit<RequestTiming, 'durationMs'> {
  count: number;
  windowMs: number;
  minMs: number;
  avgMs: number;
  maxMs: number;
}

export class RequestLogBatch {
  private readonly groups = new Map<string, Group>();
  private windowStart = -1;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly emitSummary: (summary: RequestLogSummary) => void) {}

  record(request: RequestTiming, emitDetail: () => void, now: number): void {
    const start = Math.floor(now / REQUEST_LOG_WINDOW_MS) * REQUEST_LOG_WINDOW_MS;
    if (this.windowStart !== start) {
      this.flush(now);
      this.windowStart = start;
      this.timer = setTimeout(() => this.flush(Date.now()), start + REQUEST_LOG_WINDOW_MS - now);
      this.timer.unref();
    }
    const key = `${request.scope}\0${request.type}\0${request.path}`;
    const group = this.groups.get(key);
    const duration = request.durationMs;
    if (!group) {
      emitDetail();
      if (this.groups.size < MAX_GROUPS) {
        this.groups.set(key, {
          request,
          count: 1,
          min: duration,
          max: duration,
          sum: duration,
          details: [],
        });
      }
      return;
    }
    group.count++;
    group.min = Math.min(group.min, duration);
    group.max = Math.max(group.max, duration);
    group.sum += duration;
    if (group.count < REQUEST_LOG_BATCH_THRESHOLD) group.details.push(emitDetail);
    else if (group.count === REQUEST_LOG_BATCH_THRESHOLD) group.details.length = 0;
  }

  flush(now: number): void {
    clearTimeout(this.timer);
    const windowMs = Math.max(1, Math.min(REQUEST_LOG_WINDOW_MS, now - this.windowStart));
    for (const group of this.groups.values()) {
      if (group.count < REQUEST_LOG_BATCH_THRESHOLD) {
        for (const emit of group.details) emit();
      } else {
        const { scope, path, type } = group.request;
        this.emitSummary({
          scope,
          path,
          type,
          windowMs,
          count: group.count,
          minMs: group.min,
          avgMs: Math.round((group.sum / group.count) * 10) / 10,
          maxMs: group.max,
        });
      }
    }
    this.groups.clear();
    this.windowStart = -1;
  }
}
