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

// ts/login-accounts.ts
var import_node_net = __toESM(require("node:net"));

// ts/wrapper-types.ts
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

// ts/login-accounts.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
var PIPE_NAME = process.env.NINEBIRD_PIPE_NAME || "";
var TIMEOUT_MS = parseInt(process.env.NINEBIRD_TIMEOUT_MS || "30000", 10);
var NB_LOG = process.env.NINEBIRD_LOG || "";
function nbLog(msg) {
  if (!NB_LOG) return;
  try {
    import_node_fs2.default.appendFileSync(NB_LOG, `[loader:account pid=${process.pid}] ${msg}
`);
  } catch {
  }
}
nbLog(`loaded. PIPE_NAME=${PIPE_NAME} TIMEOUT_MS=${TIMEOUT_MS}`);
var pipeClient = null;
var shutdownCalled = false;
function ensurePipeOpen() {
  if (!PIPE_NAME) {
    nbLog("ensurePipeOpen: PIPE_NAME empty, skip");
    return Promise.resolve();
  }
  if (pipeClient) return Promise.resolve();
  nbLog(`ensurePipeOpen: connecting to ${PIPE_NAME}`);
  return new Promise((resolve) => {
    const c = import_node_net.default.createConnection(PIPE_NAME);
    const onReady = () => {
      c.removeListener("error", onErr);
      pipeClient = c;
      nbLog("ensurePipeOpen: connected");
      c.on("error", () => process.exit(1));
      resolve();
    };
    const onErr = (e) => {
      c.removeListener("connect", onReady);
      nbLog(`ensurePipeOpen: connect FAILED: ${e && e.message}`);
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
function summarizeLoginList(items) {
  return items.filter((u) => u.isQuickLogin).map((u) => ({
    uin: u.uin,
    uid: u.uid,
    nickName: u.nickName,
    faceUrl: u.faceUrl,
    facePath: u.facePath,
    loginType: u.loginType,
    isQuickLogin: u.isQuickLogin,
    isAutoLogin: u.isAutoLogin
  }));
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
  nbLog("main() start");
  await ensurePipeOpen();
  setTimeout(() => {
    if (!shutdownCalled) {
      void sendResultAndExit(false, "timeout");
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
    hooker.installRecvHook((ev) => {
      const hex = ev.hex_data;
      if (!hex || !hex.startsWith("08de19") && !hex.startsWith("08DE19")) {
        return;
      }
    });
    let dataPathGlobal = qqInfo.dataPathGlobal;
    try {
      const util = wrapper.NodeQQNTWrapperUtil;
      const real = util?.getNTUserDataInfoConfig?.();
      if (real) {
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
    try {
      const startupCtor = wrapper.NodeIQQNTStartupSessionWrapper;
      if (startupCtor?.create) {
        startupCtor.create();
      }
      const sessCtor = wrapper.NodeIQQNTWrapperSession;
      if (sessCtor?.getNTWrapperSession) {
        sessCtor.getNTWrapperSession("nt_1");
      } else if (sessCtor?.create) {
        sessCtor.create();
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
    const loginList = await loginService.getLoginList();
    await sendMessage({
      kind: "login-list",
      list: summarizeLoginList(loginList.LocalLoginInfoList)
    });
    return sendResultAndExit(true);
  } catch (error) {
    nbLog(`main() threw: ${String(error)}`);
    void sendResultAndExit(false, String(error));
  }
}
main().catch((err) => {
  nbLog(`main() rejected: ${String(err)}`);
  void sendResultAndExit(false, String(err));
});
