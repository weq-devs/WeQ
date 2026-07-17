"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ts/qr-dbkey.ts
var import_node_net = __toESM(require("node:net"));

// ts/wrapper-types.ts
var NodeIKernelLoginListener = class {
  onLoginConnected() {
  }
  onLoginDisConnected(...args) {
  }
  onLoginConnecting(...args) {
  }
  onQRCodeGetPicture(arg) {
  }
  onQRCodeLoginPollingStarted(...args) {
  }
  onQRCodeSessionUserScaned(...args) {
  }
  onQRCodeLoginSucceed(arg) {
  }
  onQRCodeSessionFailed(errType, errCode, ...args) {
  }
  onLoginFailed(...args) {
  }
  onLogoutSucceed(...args) {
  }
  onLogoutFailed(...args) {
  }
  onUserLoggedIn(userid) {
  }
  onQRCodeSessionQuickLoginFailed(...args) {
  }
  onPasswordLoginFailed(...args) {
  }
  OnConfirmUnusualDeviceFailed(...args) {
  }
  onQQLoginNumLimited(...args) {
  }
  onLoginState(...args) {
  }
  onLoginRecordUpdate(...args) {
  }
};
var NodeIGlobalAdapter = class {
  onLog(..._args) {
  }
  onGetSrvCalTime(..._args) {
  }
  onShowErrUITips(..._args) {
  }
  fixPicImgType(..._args) {
  }
  getAppSetting(..._args) {
  }
  onInstallFinished(..._args) {
  }
  onUpdateGeneralFlag(..._args) {
  }
  onGetOfflineMsg(..._args) {
  }
};
var NodeIDependsAdapter = class {
  onMSFStatusChange(..._args) {
  }
  onMSFSsoError(..._args) {
  }
  getGroupCode(..._args) {
  }
};
var NodeIDispatcherAdapter = class {
  dispatchRequest(..._arg) {
  }
  dispatchCall(..._arg) {
  }
  dispatchCallWithJson(..._arg) {
  }
};
var NodeIKernelSessionListener = class {
  onNTSessionCreate(..._args) {
  }
  onGProSessionCreate(..._args) {
  }
  onSessionInitComplete(..._args) {
  }
  // wrapper 在 session 完全就绪后会调这个 —— 收到 is_init=true 等于 session ready。
  onOpentelemetryInit(_info) {
  }
  onUserOnlineResult(..._args) {
  }
  onGetSelfTinyId(..._args) {
  }
};
var NodeIO3MiscListener = class {
  getOnAmgomDataPiece(..._args) {
    return void 0;
  }
};

// ts/qq-info.ts
var import_node_fs = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path = __toESM(require("node:path"));
function defaultVersionConfig() {
  if (import_node_os.default.platform() === "linux") {
    return {
      baseVersion: "3.2.12.28060",
      curVersion: "3.2.12.28060",
      prevVersion: "",
      onErrorVersions: [],
      buildId: "27254"
    };
  }
  if (import_node_os.default.platform() === "darwin") {
    return {
      baseVersion: "6.9.53.28060",
      curVersion: "6.9.53.28060",
      prevVersion: "",
      onErrorVersions: [],
      buildId: "28060"
    };
  }
  return {
    baseVersion: "9.9.15-28131",
    curVersion: "9.9.15-28131",
    prevVersion: "",
    onErrorVersions: [],
    buildId: "28131"
  };
}
function getVersionConfigPath(execPath) {
  let p;
  if (import_node_os.default.platform() === "win32") {
    p = import_node_path.default.join(import_node_path.default.dirname(execPath), "versions", "config.json");
  } else if (import_node_os.default.platform() === "darwin") {
    p = import_node_path.default.resolve(import_node_os.default.homedir(), "./Library/Application Support/QQ/versions/config.json");
  } else {
    p = import_node_path.default.resolve(import_node_os.default.homedir(), "./.config/QQ/versions/config.json");
  }
  if (!import_node_fs.default.existsSync(p)) {
    p = import_node_path.default.join(import_node_path.default.dirname(execPath), "./resources/app/versions/config.json");
  }
  return import_node_fs.default.existsSync(p) ? p : void 0;
}
function getPackageInfoPath(execPath, version) {
  let p;
  if (import_node_os.default.platform() === "darwin") {
    p = import_node_path.default.join(import_node_path.default.dirname(execPath), "..", "Resources", "app", "package.json");
  } else if (import_node_os.default.platform() === "linux") {
    p = import_node_path.default.join(import_node_path.default.dirname(execPath), "./resources/app/package.json");
  } else {
    p = import_node_path.default.join(import_node_path.default.dirname(execPath), "./versions/" + version + "/resources/app/package.json");
  }
  if (!import_node_fs.default.existsSync(p)) {
    p = import_node_path.default.join(import_node_path.default.dirname(execPath), "./resources/app/versions/" + version + "/package.json");
  }
  return p;
}
function resolveWrapperPath(execPath, version) {
  let appPath;
  if (import_node_os.default.platform() === "darwin") {
    appPath = import_node_path.default.resolve(import_node_path.default.dirname(execPath), "../Resources/app");
  } else if (import_node_os.default.platform() === "linux") {
    appPath = import_node_path.default.resolve(import_node_path.default.dirname(execPath), "./resources/app");
  } else {
    appPath = import_node_path.default.resolve(import_node_path.default.dirname(execPath), `./versions/${version}/`);
  }
  let wp = import_node_path.default.resolve(appPath, "wrapper.node");
  if (!import_node_fs.default.existsSync(wp)) {
    wp = import_node_path.default.join(appPath, "./resources/app/wrapper.node");
  }
  if (!import_node_fs.default.existsSync(wp)) {
    wp = import_node_path.default.join(import_node_path.default.dirname(execPath), `./resources/app/versions/${version}/wrapper.node`);
  }
  if (!import_node_fs.default.existsSync(wp)) {
    throw new Error(`wrapper.node not found near ${execPath}`);
  }
  return wp;
}
function getDataPaths(execPath, getNTUserDataInfoConfig) {
  if (import_node_os.default.platform() === "darwin") {
    const root = import_node_path.default.resolve(import_node_os.default.homedir(), "./Library/Application Support/QQ");
    return [root, import_node_path.default.join(root, "global")];
  }
  let dataPath = getNTUserDataInfoConfig?.();
  if (!dataPath) {
    dataPath = import_node_path.default.resolve(import_node_os.default.homedir(), "./.config/QQ");
    import_node_fs.default.mkdirSync(dataPath, { recursive: true });
  }
  if (import_node_os.default.platform() === "linux") {
    return [dataPath, import_node_path.default.resolve(dataPath, "./global")];
  }
  return [dataPath, import_node_path.default.resolve(dataPath, "./nt_qq/global")];
}
function getAppIdFallback() {
  if (import_node_os.default.platform() === "darwin" || import_node_os.default.platform() === "linux") return "537246140";
  return "537246092";
}
function getQuaFallback(fullVersion, buildVer) {
  const verNoBuild = fullVersion.split("-")[0];
  if (import_node_os.default.platform() === "darwin") return `V1_MAC_NQ_${verNoBuild}_${buildVer}_GW_B`;
  if (import_node_os.default.platform() === "linux") return `V1_LNX_NQ_${verNoBuild}_${buildVer}_GW_B`;
  return `V1_WIN_NQ_${verNoBuild}_${buildVer}_GW_B`;
}
function resolveAppidAndQua(fullVersion, buildVer) {
  return { appid: getAppIdFallback(), qua: getQuaFallback(fullVersion, buildVer) };
}
function resolveQQInfo(execPath, opts = {}) {
  const versionConfigPath = getVersionConfigPath(execPath);
  const versionConfig = versionConfigPath ? JSON.parse(import_node_fs.default.readFileSync(versionConfigPath, "utf-8")) : defaultVersionConfig();
  const fullVersion = versionConfigPath ? versionConfig.curVersion : versionConfig.curVersion;
  const packagePath = getPackageInfoPath(execPath, fullVersion);
  let packageInfo = {};
  if (import_node_fs.default.existsSync(packagePath)) {
    packageInfo = JSON.parse(import_node_fs.default.readFileSync(packagePath, "utf-8"));
  }
  const resolvedVersion = fullVersion || packageInfo.version || versionConfig.baseVersion;
  const buildVer = resolvedVersion.split("-")[1] ?? resolvedVersion.split(".").slice(-1)[0] ?? packageInfo.buildVersion ?? versionConfig.buildId;
  const wrapperPath = resolveWrapperPath(execPath, resolvedVersion);
  const [dataPath, dataPathGlobal] = getDataPaths(execPath, opts.ntUserDataInfoConfig);
  const resolved = resolveAppidAndQua(resolvedVersion, buildVer);
  const appid = opts.appid ?? resolved.appid;
  const qua = opts.qua ?? resolved.qua;
  return {
    execPath,
    wrapperPath,
    fullVersion: resolvedVersion,
    buildVer,
    dataPath,
    dataPathGlobal,
    appid,
    qua
  };
}
function getPlatformType() {
  switch (import_node_os.default.platform()) {
    case "win32":
      return 3;
    case "darwin":
      return 4;
    case "linux":
      return 5;
    default:
      return 3;
  }
}
function getSystemHostname() {
  return import_node_os.default.hostname();
}
function getSystemVersion() {
  return import_node_os.default.release();
}

// ts/qr-dbkey.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
var PIPE_NAME = process.env.NINEBIRD_PIPE_NAME || "";
var TIMEOUT_MS = parseInt(process.env.NINEBIRD_TIMEOUT_MS || "180000", 10);
var pipeClient = null;
var shutdownCalled = false;
var dbkey = null;
function ensurePipeOpen() {
  if (!PIPE_NAME) return Promise.resolve();
  if (pipeClient) return Promise.resolve();
  return new Promise((resolve) => {
    const c = import_node_net.default.createConnection(PIPE_NAME);
    const onReady = () => {
      c.removeListener("error", onErr);
      pipeClient = c;
      c.on("error", () => process.exit(1));
      resolve();
    };
    const onErr = () => {
      c.removeListener("connect", onReady);
      resolve();
    };
    c.once("connect", onReady);
    c.once("error", onErr);
  });
}
function sendMessage(obj) {
  if (!pipeClient) return Promise.resolve();
  return new Promise((resolve) => {
    pipeClient.write(JSON.stringify(obj) + "\n", () => resolve());
  });
}
async function sendResultAndExit(success, error) {
  if (shutdownCalled) return;
  shutdownCalled = true;
  const result = {
    kind: "result",
    success,
    dbkey: dbkey || void 0,
    error: error || void 0
  };
  if (!pipeClient) {
    process.exit(success ? 0 : 1);
  }
  try {
    await sendMessage(result);
  } catch {
  }
  pipeClient.end(() => {
    setTimeout(() => process.exit(0), 100);
  });
}
function loadQQWrapper(execPath, qqVersion) {
  if (process.env["NAPCAT_WRAPPER_PATH"]) {
    const wrapperPath = process.env["NAPCAT_WRAPPER_PATH"];
    const nativemodule2 = { exports: {} };
    process.dlopen(nativemodule2, wrapperPath);
    return nativemodule2.exports;
  }
  if (!execPath) {
    throw new Error("\u65E0\u6CD5\u52A0\u8F7D Wrapper\uFF0CexecPath \u672A\u5B9A\u4E49");
  }
  let appPath;
  if (process.platform === "darwin") {
    appPath = import_node_path2.default.resolve(import_node_path2.default.dirname(execPath), "../Resources/app");
  } else if (process.platform === "linux") {
    appPath = import_node_path2.default.resolve(import_node_path2.default.dirname(execPath), "./resources/app");
  } else {
    appPath = import_node_path2.default.resolve(import_node_path2.default.dirname(execPath), `./versions/${qqVersion}/`);
  }
  let wrapperNodePath = import_node_path2.default.resolve(appPath, "wrapper.node");
  if (!import_node_fs2.default.existsSync(wrapperNodePath)) {
    wrapperNodePath = import_node_path2.default.join(appPath, "./resources/app/wrapper.node");
  }
  if (!import_node_fs2.default.existsSync(wrapperNodePath)) {
    wrapperNodePath = import_node_path2.default.join(import_node_path2.default.dirname(execPath), `./resources/app/versions/${qqVersion}/wrapper.node`);
  }
  const nativemodule = { exports: {} };
  process.dlopen(nativemodule, wrapperNodePath);
  process.env["NAPCAT_WRAPPER_PATH"] = wrapperNodePath;
  return nativemodule.exports;
}
async function main() {
  await ensurePipeOpen();
  setTimeout(() => {
    if (!shutdownCalled) {
      void sendResultAndExit(false, "NINEBIRD global timeout (Did you forget to scan?)");
    }
  }, TIMEOUT_MS);
  try {
    const qqInfo = resolveQQInfo(process.execPath, {
      appid: process.env.NINEBIRD_APPID || void 0,
      qua: process.env.NINEBIRD_QUA || void 0
    });
    const wrapper = loadQQWrapper(qqInfo.execPath, qqInfo.fullVersion);
    const loaderDir = process.env.NINEBIRD_LOADER_DIR || (process.env.NINEBIRD_LOAD_PATH ? import_node_path2.default.dirname(process.env.NINEBIRD_LOAD_PATH) : __dirname);
    const hookerPath = import_node_path2.default.join(loaderDir, "NineBird.node");
    if (!import_node_fs2.default.existsSync(hookerPath)) {
      return sendResultAndExit(false, `NineBird.node not found: ${hookerPath}`);
    }
    const hooker = require(hookerPath);
    const isPrintableAscii = (b) => b >= 32 && b <= 126;
    hooker.installRecvHook((ev) => {
      const hex = ev.hex_data;
      if (!hex || !hex.startsWith("08de19") && !hex.startsWith("08DE19")) return;
      const buf = Buffer.from(hex, "hex");
      for (let i = 0; i + 18 <= buf.length; i++) {
        if (buf[i] !== 10 || buf[i + 1] !== 16) continue;
        const start = i + 2;
        const slice = buf.slice(start, start + 16);
        let allAscii = true;
        for (let k = 0; k < 16; k++) {
          if (!isPrintableAscii(slice[k])) {
            allAscii = false;
            break;
          }
        }
        if (allAscii) {
          dbkey = slice.toString("ascii");
          void sendResultAndExit(true);
          return;
        }
        void sendResultAndExit(false, "0xcde_2 \u5305\u91CC 16 \u5B57\u8282\u6BB5\u542B\u975E ASCII \u5B57\u8282\uFF0Cdbkey \u83B7\u53D6\u5931\u8D25");
        return;
      }
      void sendResultAndExit(false, '0xcde_2 \u5305\u91CC\u6CA1\u6709 "0A 10" \u6807\u8BB0\uFF0Cdbkey \u83B7\u53D6\u5931\u8D25');
    });
    let realDataPath = qqInfo.dataPath;
    let dataPathGlobal = qqInfo.dataPathGlobal;
    try {
      const util = wrapper.NodeQQNTWrapperUtil;
      const real = util?.getNTUserDataInfoConfig?.();
      if (real) {
        realDataPath = real;
        dataPathGlobal = process.platform === "linux" ? import_node_path2.default.resolve(real, "./global") : import_node_path2.default.resolve(real, "./nt_qq/global");
      }
    } catch (e) {
    }
    const engine = wrapper.NodeIQQNTWrapperEngine.get();
    engine.initWithDeskTopConfig(
      {
        base_path_prefix: "",
        platform_type: getPlatformType(),
        app_type: 4,
        app_version: qqInfo.fullVersion,
        os_version: getSystemVersion(),
        use_xlog: false,
        qua: qqInfo.qua,
        global_path_config: { desktopGlobalPath: dataPathGlobal },
        thumb_config: { maxSide: 324, minSide: 48, longLimit: 6, density: 2 }
      },
      new NodeIGlobalAdapter()
    );
    let startupSession = null;
    let ntSession = null;
    try {
      const startupCtor = wrapper.NodeIQQNTStartupSessionWrapper;
      if (startupCtor?.create) {
        startupSession = startupCtor.create();
      }
      const sessCtor = wrapper.NodeIQQNTWrapperSession;
      if (sessCtor?.getNTWrapperSession) {
        ntSession = sessCtor.getNTWrapperSession("nt_1");
      } else if (sessCtor?.create) {
        ntSession = sessCtor.create();
      }
    } catch (e) {
    }
    const o3Service = wrapper.NodeIO3MiscService.get();
    o3Service.addO3MiscListener(new NodeIO3MiscListener());
    const loginService = wrapper.NodeIKernelLoginService.get();
    loginService.initConfig({
      machineId: "",
      appid: qqInfo.appid,
      platVer: getSystemVersion(),
      commonPath: dataPathGlobal,
      clientVer: qqInfo.fullVersion,
      hostName: getSystemHostname(),
      externalVersion: false
    });
    const ts = Date.now().toString();
    o3Service.reportAmgomWeather("login", "a1", [ts, "0", "0"]);
    let loginUid = "";
    let loginUin = "";
    await new Promise((resolve, reject) => {
      const listener = new NodeIKernelLoginListener();
      listener.onLoginConnected = () => {
        const waitForMsfAndGetQr = async () => {
          for (let tries = 0; ; tries++) {
            const s = loginService.getMsfStatus();
            if (s !== 3) break;
            if (tries > 60) {
              return reject(new Error("\u7B49\u5F85 MSF \u7F51\u7EDC\u8FDE\u63A5\u8D85\u65F6\uFF0830s\uFF09"));
            }
            await new Promise((r) => setTimeout(r, 500));
          }
          loginService.getQRCodePicture();
        };
        waitForMsfAndGetQr().catch(reject);
      };
      listener.onQRCodeGetPicture = (data) => {
        void sendMessage({ kind: "qrcode", url: data.qrcodeUrl });
      };
      listener.onQRCodeSessionFailed = (errType, errCode) => {
        void sendMessage({ kind: "qrcode-state", state: `\u72B6\u6001\u7801\u5F02\u5E38 Type:${errType} Code:${errCode}\uFF0C\u6B63\u5728\u91CD\u65B0\u62C9\u53D6\u4E8C\u7EF4\u7801...` });
        loginService.getQRCodePicture();
      };
      listener.onQRCodeLoginSucceed = (loginResult) => {
        loginUid = loginResult.uid;
        loginUin = String(loginResult.uin);
        void sendMessage({ kind: "qrcode-state", state: `\u626B\u7801\u6210\u529F\uFF01\u5F53\u524D\u767B\u5F55\u8D26\u53F7 UIN: ${loginUin}` });
        resolve();
      };
      listener.onUserLoggedIn = (userid) => {
        void sendResultAndExit(false, `\u65E0\u6CD5\u767B\u5F55: \u5F53\u524D\u7CFB\u7EDF\u5185\u8D26\u53F7 (${userid}) \u72B6\u6001\u5F02\u5E38\u6216\u5DF2\u5728\u767B\u5F55\u72B6\u6001\u3002`);
      };
      listener.onLoginFailed = (...args) => {
        void sendResultAndExit(false, `Kernel Core \u767B\u5F55\u906D\u9047\u786C\u5931\u8D25: ${JSON.stringify(args)}`);
      };
      loginService.addKernelLoginListener(listener);
      const ok = loginService.connect();
      if (!ok) reject(new Error("loginService.connect() \u521D\u59CB\u5316\u5931\u8D25 (\u8FD4\u56DE false)"));
    });
    const amgomDataPiece = "eb1fd6ac257461580dc7438eb099f23aae04ca679f4d88f53072dc56e3bb1129";
    o3Service.setAmgomDataPiece(qqInfo.appid, new Uint8Array(Buffer.from(amgomDataPiece, "hex")));
    let guid = loginService.getMachineGuid();
    guid = guid.slice(0, 8) + "-" + guid.slice(8, 12) + "-" + guid.slice(12, 16) + "-" + guid.slice(16, 20) + "-" + guid.slice(20);
    o3Service.reportAmgomWeather("login", "a6", [ts, "184", "329"]);
    const downloadPath = import_node_path2.default.join(realDataPath, "NapCat", "temp");
    try {
      import_node_fs2.default.mkdirSync(downloadPath, { recursive: true });
    } catch {
    }
    const platformType = getPlatformType();
    const sessionConfig = {
      selfUin: loginUin,
      // <== 这里采用扫码后动态获得的 UIN
      selfUid: loginUid,
      // <== 这里采用扫码后动态获得的 UID
      desktopPathConfig: {
        account_path: realDataPath
      },
      clientVer: qqInfo.fullVersion,
      a2: "",
      d2: "",
      d2Key: "",
      machineId: "",
      platform: platformType,
      platVer: getSystemVersion(),
      appid: qqInfo.appid,
      rdeliveryConfig: {
        appKey: "",
        systemId: 0,
        appId: "",
        logicEnvironment: "",
        platform: platformType,
        language: "",
        sdkVersion: "",
        userId: "",
        appVersion: "",
        osVersion: "",
        bundleId: "",
        serverUrl: "",
        fixedAfterHitKeys: [""]
      },
      defaultFileDownloadPath: downloadPath,
      deviceInfo: {
        guid,
        buildVer: qqInfo.fullVersion,
        localId: 2052,
        devName: getSystemHostname(),
        devType: "Windows",
        vendorName: "",
        osVer: getSystemVersion(),
        vendorOsName: "Windows",
        setMute: false,
        vendorType: 0 /* KNOSETONIOS */
      },
      deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}'
    };
    if (!ntSession) {
      return sendResultAndExit(false, "ntSession \u5B9E\u4F8B\u521B\u5EFA\u5931\u8D25");
    }
    const otelGate = new Promise((resolveOtel, rejectOtel) => {
      const sessListener = new NodeIKernelSessionListener();
      sessListener.onOpentelemetryInit = (info) => {
        if (info.is_init) resolveOtel();
        else rejectOtel(new Error("OpenTelemetry \u63A2\u9488\u521D\u59CB\u5316\u5931\u8D25"));
      };
      ntSession.init(
        sessionConfig,
        new NodeIDependsAdapter(),
        new NodeIDispatcherAdapter(),
        sessListener
      );
    });
    if (startupSession) {
      startupSession.start();
    } else {
      try {
        ntSession.startNT(0);
      } catch {
        ntSession.startNT();
      }
    }
    await Promise.race([
      otelGate,
      new Promise((_, rej) => setTimeout(() => rej(new Error("OpenTelemetry init timeout")), 15e3))
    ]).catch(() => {
    });
  } catch (error) {
    void sendResultAndExit(false, String(error));
  }
}
main().catch((err) => {
  void sendResultAndExit(false, String(err));
});
