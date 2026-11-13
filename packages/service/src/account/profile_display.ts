import {
  getSelfProfileDisplaySettings,
  setSelfProfileDisplaySetting,
  profileDisplayRaw,
  LegacyOidbRejectedError,
  type PacketNative,
  type ProfileDisplayField,
  type ProfileDisplaySetting,
} from '@weq/protocol';

export interface ProfileDisplayWriteResult {
  targetUin: string;
  field: ProfileDisplayField;
  state: 'confirmed' | 'unchanged' | 'failed' | 'unconfirmed' | 'mismatch';
  setting: ProfileDisplaySetting | null;
  error: string | null;
}

/** 仅当前账号；每个字段独立串行，其他字段不被长读回阻塞。 */
export class SelfProfileDisplayService {
  private readonly pending = new Set<ProfileDisplayField>();
  constructor(
    private readonly nt: PacketNative,
    private readonly uin: string,
    private readonly resolvePid: () => number,
  ) {}
  private check(pid: number) {
    if (this.resolvePid() !== pid) throw new Error('账号连接已变化，请重新读取资料展示设置');
  }
  async read() {
    const pid = this.resolvePid();
    const result = await getSelfProfileDisplaySettings(this.nt, pid, this.uin);
    this.check(pid);
    return result;
  }
  async set(field: ProfileDisplayField, value: number): Promise<ProfileDisplayWriteResult> {
    profileDisplayRaw(field, value);
    if (this.pending.has(field)) throw new Error('此项正在保存，请等待确认');
    this.pending.add(field);
    const result = (
      state: ProfileDisplayWriteResult['state'],
      setting: ProfileDisplaySetting | null,
      error: string | null = null,
    ): ProfileDisplayWriteResult => ({ targetUin: this.uin, field, state, setting, error });
    try {
      const pid = this.resolvePid();
      const original = (await getSelfProfileDisplaySettings(this.nt, pid, this.uin, [field]))
        .settings[0]!;
      this.check(pid);
      if (original.status !== 'known')
        return result('failed', original, '此项状态尚未确认，请重新读取');
      if (original.value === value) return result('unchanged', original);
      let accepted = false;
      try {
        await setSelfProfileDisplaySetting(this.nt, pid, this.uin, field, value);
        accepted = true;
      } catch (error) {
        this.check(pid);
        if (error instanceof LegacyOidbRejectedError)
          return result('failed', original, `保存被拒绝（${error.result}），请重新读取后重试`);
        // 传输异常可能发生在提交之后，只查询确认，不自动重发写请求。
      }
      this.check(pid);
      let setting: ProfileDisplaySetting | null = null;
      for (const delay of [0, 350, 1000]) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        this.check(pid);
        try {
          setting = (await getSelfProfileDisplaySettings(this.nt, pid, this.uin, [field]))
            .settings[0]!;
          this.check(pid);
          if (setting.status === 'known' && setting.value === value)
            return result('confirmed', setting);
        } catch {
          this.check(pid);
        }
      }
      return accepted && setting?.status === 'known'
        ? result('mismatch', setting, '读回状态与选择不一致，请重新读取核对')
        : result('unconfirmed', setting, '暂未确认保存结果，请重新读取核对');
    } finally {
      this.pending.delete(field);
    }
  }
}
