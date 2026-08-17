// Minimal subset of QQ NT wrapper.node interfaces needed to drive a login
// flow that produces an OidbSvcTrpcTcp.0xcde_2 packet. Lifted from NapCat
// (napcat-core/wrapper.ts and napcat-core/services/*); fields and methods
// we never call are omitted to keep this file readable.
export enum GeneralCallResultStatus {
    OK = 0,
    ERROR = -1,
}

export enum PlatformType {
    KUNKNOWN = 0,
    KANDROID = 1,
    KIOS = 2,
    KWINDOWS = 3,
    KMAC = 4,
    KLINUX = 5,
}

export enum VendorType {
    KNOSETONIOS = 0,
}

// ---- LoginService ---------------------------------------------------------

export interface LoginInitConfig {
    machineId: '';
    appid: string;
    platVer: string;
    commonPath: string;
    clientVer: string;
    hostName: string;
    externalVersion: boolean;
}

export interface LoginListItem {
    uin: string;
    uid: string;
    nickName: string;
    faceUrl: string;
    facePath: string;
    loginType: number;
    isQuickLogin: boolean;
    isAutoLogin: boolean;
}

export interface QuickLoginResult {
    result: string;
    loginErrorInfo?: {
        step: number;
        errMsg: string;
        proofWaterUrl: string;
        newDevicePullQrCodeSig: string;
        jumpUrl: string;
        jumpWord: string;
        tipsTitle: string;
        tipsContent: string;
    };
}

export interface QRCodeLoginSucceedResult {
    account: string;
    mainAccount: string;
    uin: string;
    uid: string;
    nickName: string;
    gender: number;
    age: number;
    faceUrl: string;
}

// QQ's runtime maps a JS object to a C++ listener; only the methods we
// implement get called back. All listener methods MUST exist as functions
// (even no-ops) because the wrapper iterates the object's keys to bind
// callbacks. So we mark every member as a function with an empty default.
export class NodeIKernelLoginListener {
    onLoginConnected(): void {}
    onLoginDisConnected(...args: unknown[]): void {}
    onLoginConnecting(...args: unknown[]): void {}
    onQRCodeGetPicture(arg: { pngBase64QrcodeData: string; qrcodeUrl: string }): void {}
    onQRCodeLoginPollingStarted(...args: unknown[]): void {}
    onQRCodeSessionUserScaned(...args: unknown[]): void {}
    onQRCodeLoginSucceed(arg: QRCodeLoginSucceedResult): void {}
    onQRCodeSessionFailed(errType: number, errCode: number, ...args: unknown[]): void {}
    onLoginFailed(...args: unknown[]): void {}
    onLogoutSucceed(...args: unknown[]): void {}
    onLogoutFailed(...args: unknown[]): void {}
    onUserLoggedIn(userid: string): void {}
    onQRCodeSessionQuickLoginFailed(...args: unknown[]): void {}
    onPasswordLoginFailed(...args: unknown[]): void {}
    OnConfirmUnusualDeviceFailed(...args: unknown[]): void {}
    onQQLoginNumLimited(...args: unknown[]): void {}
    onLoginState(...args: unknown[]): void {}
    onLoginRecordUpdate(...args: unknown[]): void {}
}

export interface NodeIKernelLoginService {
    get(): NodeIKernelLoginService;
    initConfig(config: LoginInitConfig): void;
    addKernelLoginListener(listener: NodeIKernelLoginListener): number;
    removeKernelLoginListener(listenerId: number): void;
    connect(): boolean;
    getLoginList(): Promise<{ result: number; LocalLoginInfoList: LoginListItem[] }>;
    getQRCodePicture(): boolean;
    quickLoginWithUin(uin: string): Promise<QuickLoginResult>;
    getMsfStatus(): number;
    getMachineGuid(): string;
    cancel(): unknown;
}

export interface NodeIKernelTicketService {
    get(): NodeIKernelTicketService;
    addKernelTicketListener (listener: unknown): number;
    removeKernelTicketListener (listenerId: number): void;
    forceFetchClientKey (arg: string): Promise<{
        result: GeneralCallResultStatus,
        errMsg: string
        url: string;
        keyIndex: string;
        clientKey: string;
        expireTime: string;
    }>;
    isNull (): boolean;
}

export interface NodeIKernelTipOffService {
    addKernelTipOffListener (listener: unknown): number;
    removeKernelTipOffListener (listenerId: number): void;
    tipOffSendJsData (arg1: unknown, arg2: unknown): Promise<unknown>;
    getPskey (domainList: string[], nocache: boolean): Promise<{
        result: GeneralCallResultStatus,
        errMsg: string
        domainPskeyMap: Map<string, string>;
    }>;
    tipOffMsgs (arg: unknown): Promise<unknown>;
    encodeUinAesInfo (arg1: unknown, arg2: unknown): Promise<unknown>;
    isNull (): boolean;
}



// ---- Engine + Session ------------------------------------------------------

export interface NodeIQQNTWrapperEngine {
    get(): NodeIQQNTWrapperEngine;
    initWithDeskTopConfig(config: unknown, adapter: NodeIGlobalAdapter): void;
}

// NapCat 传给 initWithDeskTopConfig 的 adapter 参数。wrapper.node 拿到这个
// 对象后会在登录/心跳等阶段反查这些方法 —— 缺方法会导致 a1 token 签发依赖的
// 上下文不完整，进而 quickLogin 拿到 stale token 返回 result:"3"。
export class NodeIGlobalAdapter {
    onLog(..._args: unknown[]): void {}
    onGetSrvCalTime(..._args: unknown[]): void {}
    onShowErrUITips(..._args: unknown[]): void {}
    fixPicImgType(..._args: unknown[]): void {}
    getAppSetting(..._args: unknown[]): void {}
    onInstallFinished(..._args: unknown[]): void {}
    onUpdateGeneralFlag(..._args: unknown[]): void {}
    onGetOfflineMsg(..._args: unknown[]): void {}
}

// 静态构造器 + 实例方法都从同一个 export 上拿（NapCat 也是这样用，例如
// wrapper.NodeIQQNTStartupSessionWrapper.create() 返回的对象上有 start()）。
export interface NodeIQQNTStartupSessionWrapper {
    create(): NodeIQQNTStartupSessionWrapperInstance;
}
export interface NodeIQQNTStartupSessionWrapperInstance {
    start(): void;
}

// session 这个 wrapper：新版本走 getNTWrapperSession，老版本回退 create()。
// 返回的实例上挂着 init / startNT —— 这是触发 0xcde_2 发包的真正点火位置。
export interface NodeIQQNTWrapperSession {
    getNTWrapperSession(name: string): NodeIQQNTWrapperSessionInstance;
    create(): NodeIQQNTWrapperSessionInstance;
}
export interface NodeIQQNTWrapperSessionInstance {
    // 给 wrapper 喂登录后的设备/账号配置 + 三个 adapter。完成后必须再 startNT。
    init(
        config: WrapperSessionInitConfig,
        dependsAdapter: NodeIDependsAdapter,
        dispatcherAdapter: NodeIDispatcherAdapter,
        listener: NodeIKernelSessionListener,
    ): void;
    // wrapper 的 NT 协议栈点火：调完这一刻 wrapper 才会去后端拉本地数据库密钥，
    // OidbSvcTrpcTcp.0xcde_2 包就在这里发出来。新版本接受 0；老版本不接收参数。
    startNT(arg?: number): void;
    getTicketService(): NodeIKernelTicketService;
    getTipOffService():  NodeIKernelTipOffService;
}

// session.init 的第一个参数。NapCat 的 genSessionConfig 拼这个对象 ——
// 字段名/类型必须严格一致，否则 wrapper 会拒绝甚至挂掉。
export interface WrapperSessionInitConfig {
    selfUin: string;
    selfUid: string;
    desktopPathConfig: { account_path: string };
    clientVer: string;
    a2: string;
    d2: string;
    d2Key: string;
    machineId: string;
    platform: PlatformType;
    platVer: string;
    appid: string;
    rdeliveryConfig: {
        appKey: string;
        systemId: number;
        appId: string;
        logicEnvironment: string;
        platform: PlatformType;
        language: string;
        sdkVersion: string;
        userId: string;
        appVersion: string;
        osVersion: string;
        bundleId: string;
        serverUrl: string;
        fixedAfterHitKeys: string[];
    };
    defaultFileDownloadPath: string;
    deviceInfo: {
        guid: string;
        buildVer: string;
        localId: number;
        devName: string;
        devType: string;
        vendorName: string;
        osVer: string;
        vendorOsName: string;
        setMute: boolean;
        vendorType: VendorType;
    };
    deviceConfig: string;
}

// session.init 的两个 adapter + 一个 listener。跟 NodeIGlobalAdapter 一样，
// wrapper 会反查方法存在性，给出鸭子类型 stub 就够了。
export class NodeIDependsAdapter {
    onMSFStatusChange(..._args: unknown[]): void {}
    onMSFSsoError(..._args: unknown[]): void {}
    getGroupCode(..._args: unknown[]): void {}
}
export class NodeIDispatcherAdapter {
    dispatchRequest(..._arg: unknown[]): void {}
    dispatchCall(..._arg: unknown[]): void {}
    dispatchCallWithJson(..._arg: unknown[]): void {}
}
export class NodeIKernelSessionListener {
    onNTSessionCreate(..._args: unknown[]): void {}
    onGProSessionCreate(..._args: unknown[]): void {}
    onSessionInitComplete(..._args: unknown[]): void {}
    // wrapper 在 session 完全就绪后会调这个 —— 收到 is_init=true 等于 session ready。
    onOpentelemetryInit(_info: { is_init: boolean; is_report: boolean }): void {}
    onUserOnlineResult(..._args: unknown[]): void {}
    onGetSelfTinyId(..._args: unknown[]): void {}
}

// ---- O3MiscService ---------------------------------------------------------

// wrapper 的 C++ 侧检查 listener 上至少有 getOnAmgomDataPiece 这个方法，
// 没有就抛 "Invalid argument"。其它名字不会被读 —— NapCat 也只放这一个。
export class NodeIO3MiscListener {
    getOnAmgomDataPiece(..._args: unknown[]): unknown { return undefined; }
}

export interface NodeIO3MiscService {
    get(): NodeIO3MiscService;
    addO3MiscListener(listener: NodeIO3MiscListener): number;
    reportAmgomWeather(scene: string, key: string, payload: string[]): void;
    setAmgomDataPiece(appid: string, data: Uint8Array): void;
}

// ---- NodeQQNTWrapperUtil --------------------------------------------------

export interface NodeQQNTWrapperUtil {
    get(): NodeQQNTWrapperUtil;
    getNTUserDataInfoConfig(): string;
}

// ---- Top-level wrapper -----------------------------------------------------

export interface WrapperNodeApi {
    NodeIKernelLoginService: NodeIKernelLoginService;
    NodeIQQNTWrapperEngine: NodeIQQNTWrapperEngine;
    NodeIO3MiscService: NodeIO3MiscService;
    NodeQQNTWrapperUtil: NodeQQNTWrapperUtil;
    NodeIKernelTicketService: NodeIKernelTicketService;
    NodeIKernelTipOffService: NodeIKernelTipOffService;
    // The rest of wrapper.node's exports (NodeIQQNTWrapperSession, every
    // NodeIKernel*Service, ...) is intentionally not declared here.
    // NineBird's goal is to capture 0xcde_2 during login and exit; we
    // never construct a session or call any post-login service.
    [key: string]: unknown;
}

// ---- NineBird.node native interface ----------------------------------------

export interface RecvEvent {
    type: 1;                  // 1: recv (matches NapCat NativePacketHandler shape)
    seq: bigint;
    err_code: number;
    cmd: string;
    uin: string;
    hex_data: string;         // lowercase hex
}

export interface NineBirdNative {
    installRecvHook(cb: (event: RecvEvent) => void): boolean;
    uninstallRecvHook(): void;
    isReady(): boolean;
}
