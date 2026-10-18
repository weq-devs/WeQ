import type { NtHelperBinding, SessionMaterial } from '@weq/native';
import { queueSsoWork, ssoWorkState } from './account/sso_lifecycle';
import { registerSsoSessionInTurn, type SsoClientSnapshot } from './account/sso_session';

type SessionBinding = Pick<
  NtHelperBinding,
  'setSsoSession' | 'hasSsoSession' | 'clearSsoSession' | 'resolveAppidFromMajor'
>;

/** 只管理本托管实例的原生 SSO 租约，不持久化票据，也不把登记当作网络成功。 */
export class ManagedQQSsoSession {
  private readonly owner = {};
  private closed = false;
  private registered = false;

  constructor(
    private readonly nt: SessionBinding,
    private readonly client: SsoClientSnapshot,
  ) {
    const { pid, identity, wrapperPath, majorPath } = client;
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !/^[1-9]\d*$/.test(identity.uin) ||
      !/^u_[A-Za-z0-9_-]+$/.test(identity.uid) ||
      !/^[a-f0-9]{32}$/.test(identity.guid) ||
      !Number.isSafeInteger(identity.subAppId) ||
      identity.subAppId <= 0 ||
      identity.subAppId > 0xffffffff ||
      !identity.clientVersion ||
      !wrapperPath ||
      !majorPath
    )
      throw new Error('托管 SSO 会话身份不完整');
    this.client = { pid, identity: { ...identity }, wrapperPath, majorPath };
  }

  isReady(): boolean {
    return (
      !this.closed && this.registered && ssoWorkState(this.nt, this.client.pid).owner === this.owner
    );
  }

  register(material: SessionMaterial, signal: AbortSignal): Promise<boolean> {
    const { pid, identity, wrapperPath, majorPath } = this.client;
    const current = () => !this.closed && !signal.aborted;
    return queueSsoWork(this.nt, pid, async () => {
      if (!current()) return false;
      const state = ssoWorkState(this.nt, pid);
      const accepted = await registerSsoSessionInTurn(
        this.nt,
        {
          qqWrapperNodePath: () => wrapperPath,
          qqMajorNodePath: () => majorPath,
        },
        pid,
        identity,
        material,
        current,
        this.client,
      );
      if (!accepted) return false;
      // 原生登记已替换该 PID 的内容，必须先认领，取消时才能准确回收。
      state.owner = this.owner;
      this.registered = true;
      let present = false;
      try {
        present = await this.nt.hasSsoSession(pid);
      } catch {
        /* 不可确认时回收本次登记，不发布就绪。 */
      }
      if (current() && present) return true;
      await this.clearInTurn();
      return false;
    });
  }

  private async clearInTurn(): Promise<void> {
    const state = ssoWorkState(this.nt, this.client.pid);
    if (state.owner !== this.owner) {
      this.registered = false;
      return;
    }
    await this.nt.clearSsoSession(this.client.pid);
    if (state.owner === this.owner) delete state.owner;
    this.registered = false;
  }

  close(): Promise<void> {
    this.closed = true;
    return queueSsoWork(this.nt, this.client.pid, () => this.clearInTurn());
  }
}
