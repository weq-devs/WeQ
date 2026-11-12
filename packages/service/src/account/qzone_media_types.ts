import {
  GetQzoneFeedMediaDetail,
  type QzoneNativeDetail,
  type QzoneMediaType,
  type TrpcNative,
} from '@weq/protocol';

export class QzoneMediaTypesService {
  private readonly cache = new Map<string, { expires: number; values: QzoneNativeDetail | null }>();
  private readonly pending = new Map<string, Promise<QzoneNativeDetail>>();

  constructor(
    private readonly nt: TrpcNative,
    private readonly resolvePid: () => number,
  ) {}

  async read(
    params: GetQzoneFeedMediaDetail.Params,
    signal?: AbortSignal,
  ): Promise<QzoneMediaType[]> {
    return (await this.readDetail(params, signal)).mediaTypes;
  }
  async readDetail(
    params: GetQzoneFeedMediaDetail.Params,
    signal?: AbortSignal,
    refresh = false,
  ): Promise<QzoneNativeDetail> {
    signal?.throwIfAborted();
    const pid = this.resolvePid();
    const key = JSON.stringify([pid, params.ownerUin, params.tid, params.time]);
    if (refresh) this.cache.delete(key);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      if (!cached.values) throw new Error('空间媒体类型暂时不可用。');
      return this.copy(cached.values);
    }
    let task = this.pending.get(key);
    if (!task) {
      if (this.pending.size >= 2) throw new Error('空间媒体类型正在读取。');
      task = GetQzoneFeedMediaDetail.invokeDetail(this.nt, pid, params)
        .then((values) => {
          if (this.resolvePid() !== pid) throw new Error('QQ 会话已切换。');
          this.remember(key, values, 5 * 60_000);
          return values;
        })
        .catch((error: unknown) => {
          this.remember(key, null, 30_000);
          throw error;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, task);
    }
    const values = await task;
    signal?.throwIfAborted();
    if (this.resolvePid() !== pid) throw new Error('QQ 会话已切换。');
    return this.copy(values);
  }
  private copy(value: QzoneNativeDetail): QzoneNativeDetail {
    return { ...value, mediaTypes: value.mediaTypes.map((media) => ({ ...media })) };
  }
  private remember(key: string, values: QzoneNativeDetail | null, ttl: number) {
    this.cache.delete(key);
    this.cache.set(key, { values, expires: Date.now() + ttl });
    while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
  }
}
