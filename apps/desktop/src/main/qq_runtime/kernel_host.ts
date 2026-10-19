import { constants } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { QQKernelEvent, QQKernelOptions } from './kernel_protocol';

type Handle = Record<string, unknown>;
type Listener = Record<string, (...args: unknown[]) => void>;
type EventBody = QQKernelEvent extends infer E
  ? E extends QQKernelEvent
    ? Omit<E, 'instanceId' | 'pid'>
    : never
  : never;

function object(value: unknown, label: string): Handle {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
    throw new Error(`${label} 接口不可用`);
  return value as Handle;
}
function call(handle: Handle, method: string, ...args: unknown[]): unknown {
  const fn = handle[method];
  if (typeof fn !== 'function') throw new Error(`QQ 内核不支持 ${method}`);
  return Reflect.apply(fn, handle, args);
}
function noopListener(names: readonly string[]): Listener {
  return Object.fromEntries(names.map((name) => [name, () => {}]));
}
export function qqKernelErrorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .slice(0, 1024)
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[redacted]')
    .replace(/https?:\/\/\S+/g, '[URL]');
}
function verificationUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'qq.com' || url.hostname.endsWith('.qq.com'))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** 只在独立 Worker 中调用；不读取或改写 QQ 安装入口。 */
export function loadQQKernel(wrapperPath: string, registrationPath: string): Handle {
  if (process.platform !== 'darwin') throw new Error('当前托管内核宿主只支持 macOS');
  const flags = constants.dlopen.RTLD_NOW | constants.dlopen.RTLD_GLOBAL;
  process.dlopen({ exports: {} }, registrationPath, flags);
  const module: { exports: unknown } = { exports: {} };
  process.dlopen(module, wrapperPath, flags);
  return object(module.exports, 'QQ wrapper');
}

export function validateQQKernelOptions(value: unknown): QQKernelOptions {
  const input = object(value, '托管配置');
  const client = object(input.client, '客户端版本');
  const device = object(input.device, '设备');
  const strings = [
    input.instanceId,
    input.nonce,
    input.wrapperPath,
    input.dataRoot,
    client.appId,
    client.version,
    client.qua,
    device.hostName,
    device.osVersion,
  ];
  if (strings.some((field) => typeof field !== 'string' || field.length > 4096))
    throw new Error('托管配置字段无效');
  if (!input.instanceId || !/^[a-f0-9]{32,128}$/.test(String(input.nonce)))
    throw new Error('托管实例标识无效');
  const wrapperPath = String(input.wrapperPath),
    dataRoot = String(input.dataRoot);
  if (
    !isAbsolute(wrapperPath) ||
    !isAbsolute(dataRoot) ||
    resolve(dataRoot) === dirname(resolve(dataRoot))
  )
    throw new Error('托管路径必须是有效的绝对路径');
  const underInstall = relative(dirname(wrapperPath), dataRoot);
  if (!underInstall.startsWith('..') && !isAbsolute(underInstall))
    throw new Error('不能把 QQ 安装目录作为运行数据目录');
  if (
    !/^[1-9]\d*$/.test(String(client.appId)) ||
    Number(client.appId) > 0xffffffff ||
    !client.version ||
    !client.qua
  )
    throw new Error('缺少真实 QQ 客户端身份');
  if (
    input.expectedUin !== undefined &&
    (typeof input.expectedUin !== 'string' || !/^[1-9]\d*$/.test(input.expectedUin))
  )
    throw new Error('期望账号无效');
  if (
    input.ntHelperPath !== undefined &&
    (typeof input.ntHelperPath !== 'string' ||
      input.ntHelperPath.length > 4096 ||
      !isAbsolute(input.ntHelperPath))
  )
    throw new Error('原生会话读取器路径无效');
  return {
    instanceId: String(input.instanceId),
    nonce: String(input.nonce),
    wrapperPath,
    dataRoot,
    client: {
      appId: String(client.appId),
      version: String(client.version),
      qua: String(client.qua),
    },
    device: { hostName: String(device.hostName), osVersion: String(device.osVersion) },
    ...(typeof input.expectedUin === 'string' ? { expectedUin: input.expectedUin } : {}),
    ...(typeof input.ntHelperPath === 'string' ? { ntHelperPath: input.ntHelperPath } : {}),
  };
}

/** 宿主生命周期与登录/会话事件分开，不把登录回调当作 SSO 或数据库就绪。 */
export class QQKernelHost {
  private engine: Handle | null = null;
  private login: Handle | null = null;
  private startup: Handle | null = null;
  private session: Handle | null = null;
  private listenerId: number | null = null;
  private stopped = false;
  private connected = false;
  private loginRequested = false;
  private requestedUin: string | undefined;
  private account: { uin: string; uid: string } | null = null;
  private accountGuid: string | null = null;
  private sessionReady = false;
  private startupStarted = false;
  private authenticationRequested = false;
  private hasQrSession = false;

  constructor(
    private readonly api: Handle,
    readonly options: QQKernelOptions,
    private readonly send: (event: QQKernelEvent) => void,
  ) {}

  private emit(event: EventBody): void {
    if (!this.stopped || event.type === 'stopped' || event.type === 'stopping')
      this.send({ ...event, instanceId: this.options.instanceId, pid: process.pid });
  }
  private fail(code: string, error: unknown, retryable = false): void {
    this.emit({ type: 'error', code, message: qqKernelErrorText(error), retryable });
  }
  private guard(action: (...args: unknown[]) => void): (...args: unknown[]) => void {
    return (...args) => {
      if (this.stopped) return;
      try {
        action(...args);
      } catch (error) {
        this.fail('kernel-callback', error);
      }
    };
  }

  async initialize(): Promise<void> {
    const { client, device, dataRoot } = this.options;
    const globalPath = join(dataRoot, 'global');
    await mkdir(globalPath, { recursive: true, mode: 0o700 });
    if (this.stopped) return;
    this.engine = object(call(object(this.api.NodeIQQNTWrapperEngine, '引擎'), 'get'), '引擎实例');
    this.login = object(call(object(this.api.NodeIKernelLoginService, '登录'), 'get'), '登录实例');
    this.startup = object(
      call(object(this.api.NodeIQQNTStartupSessionWrapper, '启动会话'), 'create'),
      '启动会话实例',
    );
    this.session = object(
      call(object(this.api.NodeIQQNTWrapperSession, '账号会话'), 'getNTWrapperSession', 'nt_1'),
      '账号会话实例',
    );
    const globalAdapter = noopListener([
      'onLog',
      'onGetSrvCalTime',
      'onShowErrUITips',
      'fixPicImgType',
      'getAppSetting',
      'onInstallFinished',
      'onUpdateGeneralFlag',
      'onGetOfflineMsg',
    ]);
    globalAdapter.onShowErrUITips = this.guard(() =>
      this.emit({ type: 'verification', url: null }),
    );
    call(
      this.engine,
      'initWithDeskTopConfig',
      {
        base_path_prefix: '',
        platform_type: 4,
        app_type: 4,
        app_version: client.version,
        os_version: device.osVersion,
        use_xlog: false,
        qua: client.qua,
        global_path_config: { desktopGlobalPath: globalPath },
        thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 },
      },
      globalAdapter,
    );
    call(this.login, 'initConfig', {
      machineId: '',
      appid: client.appId,
      platVer: device.osVersion,
      commonPath: globalPath,
      clientVer: client.version,
      hostName: device.hostName,
      externalVersion: false,
    });
    const listener = noopListener([
      'onLoginConnected',
      'onLoginDisConnected',
      'onLoginConnecting',
      'onQRCodeGetPicture',
      'onQRCodeLoginPollingStarted',
      'onQRCodeSessionUserScaned',
      'onQRCodeLoginSucceed',
      'onQRCodeSessionFailed',
      'onLoginFailed',
      'onLogoutSucceed',
      'onLogoutFailed',
      'onUserLoggedIn',
      'onQRCodeSessionQuickLoginFailed',
      'onPasswordLoginFailed',
      'OnConfirmUnusualDeviceFailed',
      'onQQLoginNumLimited',
      'onLoginState',
      'onLoginRecordUpdate',
    ]);
    listener.onLoginConnected = this.guard(() => {
      this.connected = true;
      this.emit({ type: 'connected' });
      if (this.loginRequested && !this.account && !this.authenticationRequested)
        void this.beginLogin().catch((error: unknown) => this.fail('login-request', error));
    });
    listener.onLoginConnecting = this.guard(() => this.emit({ type: 'connecting' }));
    listener.onLoginDisConnected = this.guard(() => {
      this.connected = false;
      this.emit({ type: 'disconnected' });
    });
    listener.onQRCodeGetPicture = this.guard((value) => {
      const qr = object(value, '二维码');
      const png =
        typeof qr.pngBase64QrcodeData === 'string'
          ? qr.pngBase64QrcodeData.replace(/^data:image\/png;base64,/, '')
          : '';
      if (!png || png.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/=\r\n]+$/.test(png))
        throw new Error('QQ 返回的二维码无效');
      if (
        !Buffer.from(png, 'base64')
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new Error('QQ 返回的二维码不是 PNG');
      this.emit({
        type: 'qr',
        pngBase64: png,
        url: typeof qr.qrcodeUrl === 'string' && qr.qrcodeUrl.length < 4096 ? qr.qrcodeUrl : '',
      });
    });
    listener.onQRCodeSessionUserScaned = this.guard(() => this.emit({ type: 'scanned' }));
    listener.onQRCodeSessionFailed = this.guard((kind, code) => {
      if (kind === 1 && code === 3) this.emit({ type: 'qr-expired' });
      else this.fail('qr-session-failed', '二维码登录未完成，请重新获取二维码');
    });
    listener.OnConfirmUnusualDeviceFailed = this.guard(() =>
      this.emit({ type: 'verification', url: null }),
    );
    listener.onQQLoginNumLimited = this.guard(() =>
      this.fail('login-limit', 'QQ 已限制当前登录次数，请稍后再试'),
    );
    listener.onLoginFailed = this.guard(() =>
      this.fail('login-failed', 'QQ 登录失败，请重新获取二维码或完成官方验证'),
    );
    listener.onUserLoggedIn = this.guard(() =>
      this.fail('already-logged-in', '该账号已有登录实例，请使用连接已有 QQ 模式'),
    );
    listener.onQRCodeLoginSucceed = this.guard((value) => {
      void this.onLogin(value).catch((error: unknown) =>
        this.fail('session-initialization', error),
      );
    });
    listener.onLogoutSucceed = this.guard(() => {
      this.account = null;
      this.sessionReady = false;
      this.emit({ type: 'disconnected' });
    });
    const listenerId = call(this.login, 'addKernelLoginListener', listener);
    this.listenerId = typeof listenerId === 'number' ? listenerId : null;
    this.emit({ type: 'initialized', exportCount: Object.keys(this.api).length });
  }

  async startLogin(uin?: string): Promise<void> {
    if (!this.login || this.stopped) throw new Error('托管内核尚未初始化');
    if (uin && !/^[1-9]\d*$/.test(uin)) throw new Error('快速登录账号无效');
    if (uin && this.options.expectedUin && uin !== this.options.expectedUin)
      throw new Error('快速登录目标与期望账号不匹配');
    if (this.account || this.loginRequested) return;
    this.requestedUin = uin;
    this.loginRequested = true;
    if (this.connected) await this.beginLogin();
    else if (call(this.login, 'connect') === false) {
      this.loginRequested = false;
      throw new Error('QQ 登录连接启动失败');
    }
  }

  private async beginLogin(): Promise<void> {
    if (!this.login || this.stopped || this.account) return;
    const uin = this.requestedUin;
    this.requestedUin = undefined;
    if (uin) {
      this.authenticationRequested = true;
      let result: Handle;
      try {
        result = object(await call(this.login, 'quickLoginWithUin', uin), '快速登录结果');
      } catch {
        if (!this.stopped) this.refreshQr();
        return;
      }
      if (this.stopped || this.account) return;
      const error = result.loginErrorInfo ? object(result.loginErrorInfo, '验证信息') : {};
      if (
        String(result.result) === '0' &&
        !(typeof error.errMsg === 'string' && error.errMsg.trim())
      )
        return;
      const url = verificationUrl(error.proofWaterUrl) ?? verificationUrl(error.jumpUrl);
      if (url) {
        this.emit({ type: 'verification', url });
        return;
      }
    }
    this.refreshQr();
  }

  refreshQr(): void {
    if (!this.login || this.stopped || this.account) return;
    if (!this.connected) throw new Error('QQ 登录连接尚未就绪');
    if (this.hasQrSession) call(this.login, 'abortPolling');
    this.authenticationRequested = true;
    this.hasQrSession = true;
    if (call(this.login, 'getQRCodePicture') === false) {
      this.hasQrSession = false;
      throw new Error('二维码请求未被内核接受');
    }
  }

  private async onLogin(value: unknown): Promise<void> {
    const identity = object(value, '登录身份');
    const uin = String(identity.uin ?? ''),
      uid = String(identity.uid ?? '');
    if (!/^[1-9]\d*$/.test(uin) || !/^u_[A-Za-z0-9_-]+$/.test(uid))
      throw new Error('QQ 登录身份不完整');
    if (this.options.expectedUin && uin !== this.options.expectedUin) {
      this.fail('account-mismatch', '扫码账号与选定账号不一致，托管实例已停止');
      await this.stop();
      return;
    }
    if (this.account) {
      if (this.account.uin !== uin || this.account.uid !== uid)
        throw new Error('账号会话在运行中发生变化');
      return;
    }
    this.account = { uin, uid };
    this.emit({ type: 'login', uin, uid });
    if (!this.login || !this.session || !this.startup) throw new Error('QQ 会话实例未创建');
    const guidRaw = String(call(this.login, 'getMachineGuid')).replace(/-/g, '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(guidRaw)) throw new Error('QQ 设备 GUID 无效');
    this.accountGuid = guidRaw;
    const guid = [
      guidRaw.slice(0, 8),
      guidRaw.slice(8, 12),
      guidRaw.slice(12, 16),
      guidRaw.slice(16, 20),
      guidRaw.slice(20),
    ].join('-');
    const downloadPath = join(this.options.dataRoot, 'weq_downloads');
    await mkdir(downloadPath, { recursive: true, mode: 0o700 });
    if (this.stopped) return;
    const listener = noopListener([
      'onNTSessionCreate',
      'onGProSessionCreate',
      'onSessionInitComplete',
      'onOpentelemetryInit',
      'onUserOnlineResult',
      'onGetSelfTinyId',
    ]);
    listener.onSessionInitComplete = this.guard(() => {
      this.sessionReady = true;
      this.emit({
        type: 'session-initialized',
        uin,
        uid,
        guid: guidRaw,
        dataRoot: this.options.dataRoot,
      });
    });
    const depends = noopListener(['onMSFStatusChange', 'onMSFSsoError', 'getGroupCode']);
    depends.onMSFStatusChange = this.guard((status) => {
      if (typeof status === 'number') this.emit({ type: 'network', status });
    });
    depends.onMSFSsoError = this.guard(() =>
      this.fail('kernel-sso', 'QQ 内核报告网络请求失败', true),
    );
    const dispatcher = noopListener(['dispatchRequest', 'dispatchCall', 'dispatchCallWithJson']);
    const { client, device } = this.options;
    call(
      this.session,
      'init',
      {
        selfUin: uin,
        selfUid: uid,
        desktopPathConfig: { account_path: this.options.dataRoot },
        clientVer: client.version,
        a2: '',
        d2: '',
        d2Key: '',
        machineId: '',
        platform: 4,
        platVer: device.osVersion,
        appid: client.appId,
        rdeliveryConfig: {
          appKey: '',
          systemId: 0,
          appId: '',
          logicEnvironment: '',
          platform: 4,
          language: '',
          sdkVersion: '',
          userId: '',
          appVersion: '',
          osVersion: '',
          bundleId: '',
          serverUrl: '',
          fixedAfterHitKeys: [''],
        },
        defaultFileDownloadPath: downloadPath,
        deviceInfo: {
          guid,
          buildVer: client.version,
          localId: 2052,
          devName: device.hostName,
          devType: 'Darwin',
          vendorName: '',
          osVer: device.osVersion,
          vendorOsName: 'Darwin',
          setMute: false,
          vendorType: 0,
        },
        deviceConfig: JSON.stringify({ appearance: { isSplitViewMode: true }, msg: {} }),
      },
      depends,
      dispatcher,
      listener,
    );
    this.startupStarted = true;
    call(this.startup, 'start');
  }

  sessionForTransport(): { uin: string; uid: string; guid: string } | null {
    if (this.stopped || !this.connected || !this.sessionReady || !this.account || !this.accountGuid)
      return null;
    return { ...this.account, guid: this.accountGuid };
  }

  health(): void {
    this.emit({
      type: 'health',
      connected: this.connected,
      loggedIn: Boolean(this.account && this.sessionReady),
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const [handle, method, args] of [
      ...(this.startupStarted ? [[this.startup, 'stop', []]] : []),
      ...(this.hasQrSession && !this.account ? [[this.login, 'abortPolling', []]] : []),
      ...(this.authenticationRequested && !this.account ? [[this.login, 'cancel', []]] : []),
      ...(this.listenerId !== null
        ? [[this.login, 'removeKernelLoginListener', [this.listenerId]]]
        : []),
      [this.login, 'destroy', []],
      [this.engine, 'destroy', []],
    ] as Array<[Handle | null, string, unknown[]]>) {
      if (!handle) continue;
      this.emit({ type: 'stopping', stage: method });
      try {
        await call(handle, method, ...args);
      } catch {
        /* 退出仍由进程监督器保证有界完成。 */
      }
    }
    this.emit({ type: 'stopped' });
  }
}
