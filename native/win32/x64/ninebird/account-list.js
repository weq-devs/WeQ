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

// ts/appid.json
var appid_default = {
  "9.9.15-28060": {
    appid: 537246092,
    qua: "V1_WIN_NQ_9.9.15_28060_GW_B"
  },
  "9.9.15-28131": {
    appid: 537246092,
    qua: "V1_WIN_NQ_9.9.15_28131_GW_B"
  },
  "3.2.12-28060": {
    appid: 537246140,
    qua: "V1_LNX_NQ_3.2.12_28060_GW_B"
  },
  "3.2.12-28131": {
    appid: 537246140,
    qua: "V1_LNX_NQ_3.2.12_28131_GW_B"
  },
  "6.9.55-28131": {
    appid: 537246115,
    qua: "V1_MAC_NQ_6.9.55_28131_GW_B"
  },
  "9.9.15-28327": {
    appid: 537249321,
    qua: "V1_WIN_NQ_9.9.15_28327_GW_B"
  },
  "3.2.12-28327": {
    appid: 537249393,
    qua: "V1_LNX_NQ_3.2.12_28327_GW_B"
  },
  "9.9.15-28418": {
    appid: 537249321,
    qua: "V1_WIN_NQ_9.9.15_28418_GW_B"
  },
  "3.2.12-28418": {
    appid: 537249393,
    qua: "V1_LNX_NQ_3.2.12_28418_GW_B"
  },
  "6.9.56-28418": {
    appid: 537249367,
    qua: "V1_MAC_NQ_6.9.56_28418_GW_B"
  },
  "9.9.15-28498": {
    appid: 537249321,
    qua: "V1_WIN_NQ_9.9.15_28498_GW_B"
  },
  "3.2.13-28788": {
    appid: 537249787,
    qua: "V1_LNX_NQ_3.2.13_28788_GW_B"
  },
  "9.9.16-28788": {
    appid: 537249739,
    qua: "V1_WIN_NQ_9.9.16_28788_GW_B"
  },
  "9.9.16-28971": {
    appid: 537249775,
    qua: "V1_WIN_NQ_9.9.16_28971_GW_B"
  },
  "3.2.13-28971": {
    appid: 537249848,
    qua: "V1_LNX_NQ_3.2.13_28971_GW_B"
  },
  "6.9.58-28971": {
    appid: 537249826,
    qua: "V1_MAC_NQ_6.9.58_28971_GW_B"
  },
  "9.9.16-29271": {
    appid: 537249813,
    qua: "V1_WIN_NQ_9.9.16_29271_GW_B"
  },
  "3.2.13-29271": {
    appid: 537249913,
    qua: "V1_LNX_NQ_3.2.13_29271_GW_B"
  },
  "6.9.59-29271": {
    appid: 537249863,
    qua: "V1_MAC_NQ_6.9.59_29271_GW_B"
  },
  "9.9.16-29456": {
    appid: 537249875,
    qua: "V1_WIN_NQ_9.9.16_29456_GW_B"
  },
  "3.2.13-29456": {
    appid: 537249996,
    qua: "V1_LNX_NQ_3.2.13_29456_GW_B"
  },
  "6.9.59-29456": {
    appid: 537249961,
    qua: "V1_MAC_NQ_6.9.59_29456_GW_B"
  },
  "9.9.16-29927": {
    appid: 537255812,
    qua: "V1_WIN_NQ_9.9.16_29927_GW_B"
  },
  "3.2.13-29927": {
    appid: 537255847,
    qua: "V1_LNX_NQ_3.2.13_29927_GW_B"
  },
  "6.9.61-29927": {
    appid: 537255836,
    qua: "V1_MAC_NQ_6.9.61_29927_GW_B"
  },
  "9.9.17-30366": {
    appid: 537258389,
    qua: "V1_WIN_NQ_9.9.17_30366_GW_B"
  },
  "3.2.15-30366": {
    appid: 537258413,
    qua: "V1_LNX_NQ_3.2.15_30366_GW_B"
  },
  "6.9.62-30366": {
    appid: 537258401,
    qua: "V1_MAC_NQ_6.9.62_30366_GW_B"
  },
  "9.9.17-30483": {
    appid: 537258439,
    qua: "V1_WIN_NQ_9.9.17_30483_GW_B"
  },
  "6.9.62-30483": {
    appid: 537258463,
    qua: "V1_MAC_NQ_6.9.62_30483_GW_B"
  },
  "3.2.15-30483": {
    appid: 537258474,
    qua: "V1_LNX_NQ_3.2.15_30483_GW_B"
  },
  "9.9.17-30594": {
    appid: 537258439,
    qua: "V1_WIN_NQ_9.9.17_30594_GW_B"
  },
  "6.9.62-30594": {
    appid: 537258463,
    qua: "V1_MAC_NQ_6.9.62_30594_GW_B"
  },
  "3.2.15-30594": {
    appid: 537258474,
    qua: "V1_LNX_NQ_3.2.15_30594_GW_B"
  },
  "9.9.17-30851": {
    appid: 537263796,
    qua: "V1_WIN_NQ_9.9.17_30851_GW_B"
  },
  "3.2.15-30851": {
    appid: 537263831,
    qua: "V1_LNX_NQ_3.2.15_30851_GW_B"
  },
  "6.9.63-30851": {
    appid: 537263820,
    qua: "V1_MAC_NQ_6.9.63_30851_GW_B"
  },
  "9.9.17-30899": {
    appid: 537263796,
    qua: "V1_WIN_NQ_9.9.17_30899_GW_B"
  },
  "3.2.15-30899": {
    appid: 537263831,
    qua: "V1_LNX_NQ_3.2.15_30899_GW_B"
  },
  "6.9.63-30899": {
    appid: 537263820,
    qua: "V1_MAC_NQ_6.9.63_30899_GW_B"
  },
  "9.9.17-31219": {
    appid: 537266450,
    qua: "V1_WIN_NQ_9.9.17_31219_GW_B"
  },
  "9.9.17-31245": {
    appid: 537266450,
    qua: "V1_WIN_NQ_9.9.17_31245_GW_B"
  },
  "3.2.15-31245": {
    appid: 537266485,
    qua: "V1_LNX_NQ_3.2.15_31245_GW_B"
  },
  "6.9.63-31245": {
    appid: 537266474,
    qua: "V1_MAC_NQ_6.9.63_31245_GW_B"
  },
  "3.2.15-31363": {
    appid: 537266535,
    qua: "V1_LNX_NQ_3.2.15_31363_GW_B"
  },
  "6.9.65-31363": {
    appid: 537266524,
    qua: "V1_MAC_NQ_6.9.65_31363_GW_B"
  },
  "9.9.17-31363": {
    appid: 537266500,
    qua: "V1_WIN_NQ_9.9.17_31363_GW_B"
  },
  "3.2.16-32690": {
    appid: 537271229,
    qua: "V1_LNX_NQ_3.2.16_32690_GW_B"
  },
  "9.9.18-32690": {
    appid: 537271194,
    qua: "V1_WIN_NQ_9.9.18_32690_GW_B"
  },
  "6.9.66-32690": {
    appid: 537271218,
    qua: "V1_MAC_NQ_6.9.66_32690_GW_B"
  },
  "3.2.16-32721": {
    appid: 537271229,
    qua: "V1_LNX_NQ_3.2.16_32721_GW_B"
  },
  "9.9.18-32793": {
    appid: 537271244,
    qua: "V1_WIN_NQ_9.9.18_32793_GW_B"
  },
  "3.2.16-32793": {
    appid: 537271279,
    qua: "V1_LNX_NQ_3.2.16_32793_GW_B"
  },
  "3.2.16-32869": {
    appid: 537271329,
    qua: "V1_LNX_NQ_3.2.16_32869_GW_B"
  },
  "9.9.18-32869": {
    appid: 537271294,
    qua: "V1_WIN_NQ_9.9.18_32869_GW_B"
  },
  "3.2.16-33139": {
    appid: 537273909,
    qua: "V1_LNX_NQ_3.2.16_33139_GW_B"
  },
  "9.9.18-33139": {
    appid: 537273874,
    qua: "V1_WIN_NQ_9.9.18_33139_GW_B"
  },
  "9.9.18-33800": {
    appid: 537273974,
    qua: "V1_WIN_NQ_9.9.18_33800_GW_B"
  },
  "3.2.16-33800": {
    appid: 537274009,
    qua: "V1_LNX_NQ_3.2.16_33800_GW_B"
  },
  "9.9.19-34231": {
    appid: 537279209,
    qua: "V1_WIN_NQ_9.9.19_34231_GW_B"
  },
  "3.2.17-34231": {
    appid: 537279245,
    qua: "V1_LNX_NQ_3.2.17_34231_GW_B"
  },
  "9.9.19-34362": {
    appid: 537279260,
    qua: "V1_WIN_NQ_9.9.19_34362_GW_B"
  },
  "3.2.17-34362": {
    appid: 537279296,
    qua: "V1_LNX_NQ_3.2.17_34362_GW_B"
  },
  "9.9.19-34467": {
    appid: 537282256,
    qua: "V1_WIN_NQ_9.9.19_34467_GW_B"
  },
  "3.2.17-34467": {
    appid: 537282292,
    qua: "V1_LNX_NQ_3.2.17_34467_GW_B"
  },
  "9.9.19-34566": {
    appid: 537282307,
    qua: "V1_WIN_NQ_9.9.19_34566_GW_B"
  },
  "3.2.17-34566": {
    appid: 537282343,
    qua: "V1_LNX_NQ_3.2.17_34566_GW_B"
  },
  "3.2.17-34606": {
    appid: 537282343,
    qua: "V1_LNX_NQ_3.2.17_34606_GW_B"
  },
  "9.9.19-34606": {
    appid: 537282307,
    qua: "V1_WIN_NQ_9.9.19_34606_GW_B"
  },
  "9.9.19-34740": {
    appid: 537290691,
    qua: "V1_WIN_NQ_9.9.19_34740_GW_B"
  },
  "3.2.17-34740": {
    appid: 537290727,
    qua: "V1_LNX_NQ_3.2.17_34740_GW_B"
  },
  "9.9.19-34958": {
    appid: 537290742,
    qua: "V1_WIN_NQ_9.9.19_34958_GW_B"
  },
  "3.2.17-35184": {
    appid: 537291084,
    qua: "V1_LNX_NQ_3.2.17_35184_GW_B"
  },
  "9.9.19-35184": {
    appid: 537291048,
    qua: "V1_WIN_NQ_9.9.19_35184_GW_B"
  },
  "3.2.17-35341": {
    appid: 537291383,
    qua: "V1_LNX_NQ_3.2.17_35341_GW_B"
  },
  "9.9.19-35341": {
    appid: 537291347,
    qua: "V1_WIN_NQ_9.9.19_35341_GW_B"
  },
  "9.9.19-35469": {
    appid: 537291398,
    qua: "V1_WIN_NQ_9.9.19_35469_GW_B"
  },
  "3.2.18-35951": {
    appid: 537296013,
    qua: "V1_LNX_NQ_3.2.18_35951_GW_B"
  },
  "9.9.20-35951": {
    appid: 537295977,
    qua: "V1_WIN_NQ_9.9.20_35951_GW_B"
  },
  "3.2.18-36580": {
    appid: 537298509,
    qua: "V1_LNX_NQ_3.2.18_36580_GW_B"
  },
  "9.9.20-36580": {
    appid: 537298473,
    qua: "V1_WIN_NQ_9.9.20_36580_GW_B"
  },
  "9.9.20-37012": {
    appid: 537304071,
    qua: "V1_WIN_NQ_9.9.20_37012_GW_B"
  },
  "3.2.18-37012": {
    appid: 537304107,
    qua: "V1_LNX_NQ_3.2.18_37012_GW_B"
  },
  "3.2.18-37051": {
    appid: 537304158,
    qua: "V1_LNX_NQ_3.2.18_37051_GW_B"
  },
  "9.9.20-37051": {
    appid: 537304122,
    qua: "V1_WIN_NQ_9.9.20_37051_GW_B"
  },
  "9.9.20-37475": {
    appid: 537304173,
    qua: "V1_WIN_NQ_9.9.20_37475_GW_B"
  },
  "3.2.18-37475": {
    appid: 537304210,
    qua: "V1_LNX_NQ_3.2.18_37475_GW_B"
  },
  "9.9.20-37625": {
    appid: 537304224,
    qua: "V1_WIN_NQ_9.9.20_37625_GW_B"
  },
  "3.2.18-37625": {
    appid: 537304261,
    qua: "V1_LNX_NQ_3.2.18_37625_GW_B"
  },
  "9.9.21-38503": {
    appid: 537307604,
    qua: "V1_WIN_NQ_9.9.21_38503_GW_B"
  },
  "3.2.19-38503": {
    appid: 537307640,
    qua: "V1_LNX_NQ_3.2.19_38503_GW_B"
  },
  "3.2.19-38626": {
    appid: 537307691,
    qua: "V1_LNX_NQ_3.2.19_38626_GW_B"
  },
  "9.9.21-38711": {
    appid: 537307655,
    qua: "V1_WIN_NQ_9.9.21_38626_GW_B"
  },
  "9.9.21-38960": {
    appid: 537313855,
    qua: "V1_WIN_NQ_9.9.21_38960_GW_B"
  },
  "3.2.19-38960": {
    appid: 537313891,
    qua: "V1_LNX_NQ_3.2.19_38960_GW_B"
  },
  "3.2.19-39038": {
    appid: 537313942,
    qua: "V1_LNX_NQ_3.2.19_39038_GW_B"
  },
  "9.9.21-39038": {
    appid: 537313906,
    qua: "V1_WIN_NQ_9.9.21_39038_GW_B"
  },
  "9.9.22-40362": {
    appid: 537314212,
    qua: "V1_WIN_NQ_9.9.22_40362_GW_B"
  },
  "3.2.20-40768": {
    appid: 537319840,
    qua: "V1_LNX_NQ_3.2.20_40768_GW_B"
  },
  "9.9.22-40768": {
    appid: 537319804,
    qua: "V1_WIN_NQ_9.9.22_40768_GW_B"
  },
  "6.9.82-40768": {
    appid: 537319829,
    qua: "V1_MAC_NQ_6.9.82_40768_GW_B"
  },
  "3.2.20-40824": {
    appid: 537319840,
    qua: "V1_LNX_NQ_3.2.20_40824_GW_B"
  },
  "9.9.22-40824": {
    appid: 537319804,
    qua: "V1_WIN_NQ_9.9.22_40824_GW_B"
  },
  "6.9.82-40824": {
    appid: 537319829,
    qua: "V1_MAC_NQ_6.9.82_40824_GW_B"
  },
  "6.9.82-40990": {
    appid: 537319880,
    qua: "V1_MAC_NQ_6.9.82_40990_GW_B"
  },
  "9.9.22-40990": {
    appid: 537319855,
    qua: "V1_WIN_NQ_9.9.22.40990_GW_B"
  },
  "3.2.20-40990": {
    appid: 537319891,
    qua: "V1_LNX_NQ_3.2.20_40990_GW_B"
  },
  "9.9.23-41679": {
    appid: 537320110,
    qua: "V1_WIN_NQ_9.9.23_41679_GW_B"
  },
  "6.9.83-41679": {
    appid: 537320135,
    qua: "V1_MAC_NQ_6.9.83_41679_GW_B"
  },
  "9.9.23-41785": {
    appid: 537320110,
    qua: "V1_WIN_NQ_9.9.23_41785_GW_B"
  },
  "6.9.83-41785": {
    appid: 537320135,
    qua: "V1_MAC_NQ_6.9.83_41785_GW_B"
  },
  "9.9.23-41857": {
    appid: 537320161,
    qua: "V1_WIN_NQ_9.9.23_41857_GW_B"
  },
  "3.2.21-41857": {
    appid: 537320197,
    qua: "V1_LNX_NQ_3.2.21_41857_GW_B"
  },
  "6.9.83-41857": {
    appid: 537320186,
    qua: "V1_MAC_NQ_6.9.83_41857_GW_B"
  },
  "3.2.21-42086": {
    appid: 537320248,
    qua: "V1_LNX_NQ_3.2.21_42086_GW_B"
  },
  "9.9.23-42086": {
    appid: 537320212,
    qua: "V1_WIN_NQ_9.9.23_42086_GW_B"
  },
  "6.9.85-42086": {
    appid: 537320237,
    qua: "V1_MAC_NQ_6.9.85_42086_GW_B"
  },
  "9.9.23-42430": {
    appid: 537320212,
    qua: "V1_WIN_NQ_9.9.23_42430_GW_B"
  },
  "9.9.25-42744": {
    appid: 537328470,
    qua: "V1_WIN_NQ_9.9.23_42744_GW_B"
  },
  "6.9.86-42744": {
    appid: 537328495,
    qua: "V1_MAC_NQ_6.9.85_42744_GW_B"
  },
  "9.9.25-42905": {
    appid: 537328521,
    qua: "V1_WIN_NQ_9.9.25_42905_GW_B"
  },
  "6.9.86-42905": {
    appid: 537328546,
    qua: "V1_MAC_NQ_6.9.86_42905_GW_B"
  },
  "3.2.22-42941": {
    appid: 537328659,
    qua: "V1_LNX_NQ_3.2.22_42941_GW_B"
  },
  "9.9.25-42941": {
    appid: 537328623,
    qua: "V1_WIN_NQ_9.9.25_42941_GW_B"
  },
  "6.9.86-42941": {
    appid: 537328648,
    qua: "V1_MAC_NQ_6.9.86_42941_GW_B"
  },
  "9.9.26-44175": {
    appid: 537336450,
    qua: "V1_WIN_NQ_9.9.26_44175_GW_B"
  },
  "9.9.26-44343": {
    appid: 537336603,
    qua: "V1_WIN_NQ_9.9.26_44343_GW_B"
  },
  "3.2.23-44343": {
    appid: 537336639,
    qua: "V1_LNX_NQ_3.2.23_44343_GW_B"
  },
  "9.9.26-44498": {
    appid: 537337416,
    qua: "V1_WIN_NQ_9.9.26_44498_GW_B"
  },
  "9.9.26-44725": {
    appid: 537337569,
    qua: "V1_WIN_NQ_9.9.26_44725_GW_B"
  },
  "9.9.27-45627": {
    appid: 537340060,
    qua: "V1_WIN_NQ_9.9.27_45627_GW_B"
  },
  "6.9.88-44725": {
    appid: 537337594,
    qua: "V1_MAC_NQ_6.9.88_44725_GW_B"
  },
  "3.2.25-45758": {
    appid: 537340249,
    qua: "V1_LNX_NQ_3.2.25_45758_GW_B"
  },
  "9.9.27-45758": {
    appid: 537340213,
    qua: "V1_WIN_NQ_9.9.27_45758_GW_B"
  },
  "3.2.26-46494": {
    appid: 537345891,
    qua: "V1_LNX_NQ_3.2.26_46494_GW_B"
  },
  "9.9.28-46494": {
    appid: 537345855,
    qua: "V1_WIN_NQ_9.9.28_46494_GW_B"
  },
  "6.9.90-46494": {
    appid: 537345879,
    qua: "V1_MAC_NQ_6.9.90_46494_GW_B"
  },
  "3.2.26-46928": {
    appid: 537345994,
    qua: "V1_LNX_NQ_3.2.26_46928_GW_B"
  },
  "9.9.28-46928": {
    appid: 537345957,
    qua: "V1_WIN_NQ_9.9.28_46928_GW_B"
  },
  "3.2.27-47354": {
    appid: 537346908,
    qua: "V1_LNX_NQ_3.2.27_47354_GW_B"
  },
  "9.9.29-47354": {
    appid: 537346872,
    qua: "V1_WIN_NQ_9.9.29_47354_GW_B"
  },
  "6.9.93-47354": {
    appid: 537346896,
    qua: "V1_MAC_NQ_6.9.93_47354_GW_B"
  },
  "9.9.30-48517": {
    appid: 537352474,
    qua: "V1_WIN_NQ_9.9.30_48517_GW_B"
  },
  "3.2.28-48517": {
    appid: 537352510,
    qua: "V1_LNX_NQ_3.2.28_48517_GW_B"
  },
  "9.9.30-48762": {
    appid: 537352525,
    qua: "V1_WIN_NQ_9.9.30_48762_GW_B"
  },
  "9.9.31-49599": {
    appid: 537355779,
    qua: "V1_WIN_NQ_9.9.31_49599_GW_B"
  }
};

// ts/qq-info.ts
var APPID_TABLE = appid_default;
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
  const entry = APPID_TABLE[fullVersion];
  if (entry) {
    return { appid: String(entry.appid), qua: entry.qua };
  }
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
var pipeClient = null;
var shutdownCalled = false;
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
  await ensurePipeOpen();
  setTimeout(() => {
    if (!shutdownCalled) {
      void sendResultAndExit(false, "timeout");
    }
  }, TIMEOUT_MS);
  try {
    const qqInfo = resolveQQInfo(process.execPath);
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
        dataPathGlobal = import_node_path2.default.resolve(real, "./nt_qq/global");
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
    void sendResultAndExit(false, String(error));
  }
}
main().catch((err) => {
  void sendResultAndExit(false, String(err));
});
