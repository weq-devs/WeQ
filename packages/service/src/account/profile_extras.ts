import {
  getProfileEnergy,
  getSignatureHistory,
  getPersonalityLabels,
  getPersonalityPhotos,
  getAnonymousQuestions,
  getEducationHistory,
  getProfileDetails,
  getSelfAvatarHistory,
  type TrpcNative,
} from '@weq/protocol';
import type { ContactMetricsService } from './contact_metrics';

const readers = {
  getProfileEnergy,
  getSignatureHistory,
  getPersonalityLabels,
  getPersonalityPhotos,
  getAnonymousQuestions,
  getEducationHistory,
};

/** 资料扩展独立按页读取，不修改 QQ 原库或把列表塞进指标快照。 */
export class ProfileExtrasService {
  contactMetrics?: ContactMetricsService;
  private readonly inflight = new Map<string, Promise<unknown>>();
  constructor(
    private readonly nt: TrpcNative,
    readonly selfUin: string,
    private readonly resolvePid: () => number,
    private readonly read: typeof readers & {
      getSelfAvatarHistory?: typeof getSelfAvatarHistory;
      getProfileDetails?: typeof getProfileDetails;
    } = readers,
  ) {}

  private async query<T>(key: string, fetch: (pid: number) => Promise<T>): Promise<T> {
    const pid = this.resolvePid();
    const current = () => {
      if (this.resolvePid() !== pid) throw new Error('账号或 QQ 进程已切换，请重新读取资料');
    };
    const run = async () => {
      current();
      const value = await fetch(pid);
      current();
      return value;
    };
    let task = this.inflight.get(key) as Promise<T> | undefined;
    if (!task) {
      task = this.contactMetrics
        ? this.contactMetrics.schedule(`profile-extras:${key}`, run)
        : run();
      this.inflight.set(key, task);
      void task
        .finally(() => {
          if (this.inflight.get(key) === task) this.inflight.delete(key);
        })
        .catch(() => {});
    }
    const value = await task;
    current();
    return value;
  }

  energy(uin: string) {
    return this.query(`energy:${uin}`, (pid) => this.read.getProfileEnergy(this.nt, pid, uin));
  }
  details(uin: string) {
    return this.query(`details:${uin}`, (pid) =>
      (this.read.getProfileDetails ?? getProfileDetails)(this.nt, pid, uin),
    );
  }
  avatarHistory(before?: number) {
    return this.query(`self-avatars:${before ?? ''}`, async (pid) => ({
      ...(await (this.read.getSelfAvatarHistory ?? getSelfAvatarHistory)(this.nt, pid, before)),
      targetUin: this.selfUin,
    }));
  }
  educationHistory(uin: string) {
    return this.query(`education:${uin}`, (pid) =>
      this.read.getEducationHistory(this.nt, pid, uin),
    );
  }
  signatureHistory(uin: string, before?: number) {
    return this.query(`signatures:${uin}:${before ?? ''}`, (pid) =>
      this.read.getSignatureHistory(this.nt, pid, uin, before),
    );
  }
  personalityLabels(uin: string) {
    return this.query(`labels:${uin}`, (pid) => this.read.getPersonalityLabels(this.nt, pid, uin));
  }
  personalityPhotos(uin: string, labelId: string, cursor?: string) {
    return this.query(`photos:${uin}:${labelId}:${cursor ?? ''}`, (pid) =>
      this.read.getPersonalityPhotos(this.nt, pid, uin, labelId, cursor),
    );
  }
  anonymousQuestions(uin: string, filter: 'all' | 'answered', cursor?: string) {
    const effective = uin === this.selfUin ? filter : 'answered';
    return this.query(`questions:${uin}:${effective}:${cursor ?? ''}`, (pid) =>
      this.read.getAnonymousQuestions(this.nt, pid, uin, effective, cursor),
    );
  }
}
