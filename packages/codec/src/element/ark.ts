/**
 * ARK sample payloads — captured real-world examples kept as typed constants
 * for documentation. The actual ArkElement codec lives in `registry.ts`
 * (decode/encode is a thin field forward); the JSON shape of `arkData` is
 * described by `ArkPayload` in `types.ts`.
 *
 *   const payload = JSON.parse(el.arkData) as ArkPayload;
 *   if (payload.view === 'pubAdArkView') {
 *     const t = payload.meta.template3 as Record<string, unknown>;
 *     // ...
 *   }
 *
 * Add more sample constants here as you reverse-engineer other `view` shapes.
 */

import type { ArkPayload } from './types';

/**
 * Reference shape for `view: "pubAdArkView"` — QQ game-center ad pushed
 * into a chat. The whole document gets `JSON.stringify`'d into wire field
 * 47901.
 */
export const SAMPLE_GAME_CENTER_AD: ArkPayload = {
  app: 'com.tencent.gamecenter.mall',
  desc: 'QQ手游消息',
  meta: {
    template3: {
      __preloadFields: 'coverUrl',
      actId: 3062270,
      actTitle: 'CZN-首发活动',
      adId: '2974368',
      appid: '1112280105',
      arkType: 'pubSinglePicArk',
      buttonType: 1,
      contentText: '注册赢显卡福利',
      coverUrl: 'https://img.gamecenter.qq.com/oasis/Czn/6d879eb2a28a3e77167dc6d8d64ed5f2.jpg',
      feedId: 40350761,
      fid: 40350761,
      five_element_switch: false,
      is_colorful: false,
      styleType: 1,
      time: '1780543611',
      title: '卡厄思梦境现已上线',
      url: 'https://youxi.gamecenter.qq.com/compose-h5/mie-act/gamecenter_template_subscribe/index.html?adid=2974368&adtag=gzh_s_2974368_s_40350761&appid=1112280105&fid=40350761&oasis_actid=3062270&open_kuikly_info=%7B%22url%22%3A%22%3FFFROMSCHEMA%3D%26act_id%3D3062270_1112280105_AyvJiB%26adtag%3Dgzh_s_2974368_s_40350761%26_gen_from%3Dqga%22%2C%22page_name%22%3A%22QQGameCenterTemplateSubscribe%22%2C%22bundle_name%22%3A%22gamecenter_template_subscribe%22%2C%22kr_turbo_display%22%3A%223062270_1112280105_AyvJiB%22%2C%22kr_min_res_version%22%3A%2214240%22%7D&page_name=QQGameCenterTemplateSubscribe&pubAccountAppid=1112280105&qqplay=1&qqplayHide=1&restag=2974368',
    },
  },
  prompt: '卡厄思梦境现已上线',
  sourceName: '1112280105',
  ver: '0.0.3.67',
  view: 'pubAdArkView',
  config: {
    ctime: 1780873865,
    token: 'da8a31c3da3d28c78696dd193496ab2c',
  },
};

/**
 * Another game-center ad sample (手游瓦洛兰特).
 */
export const SAMPLE_GAME_CENTER_AD_2: ArkPayload = {
  app: 'com.tencent.gamecenter.mall',
  desc: 'QQ手游消息',
  meta: {
    template3: {
      __preloadFields: 'coverUrl',
      actId: 3071715,
      actTitle: '手瓦新版暑期活动',
      adId: '3178153',
      appid: '1111677210',
      arkType: 'pubSinglePicArk',
      busiContent: null,
      buttonType: 0,
      contentText: '正版手游，秀出神操作！',
      coverUrl: 'https://img.gamecenter.qq.com/oasis/Projectc/bc3f0b64aeec6d159f008c19a6be5149.png',
      feedId: 40390485,
      fid: 40390485,
      five_element_switch: false,
      is_colorful: false,
      styleType: 1,
      time: '1782892042',
      title: '不开电脑，也能打瓦',
      url: 'https://youxi.gamecenter.qq.com/compose-h5/mie-act/gamecenter_template_subscribe/index.html?adid=3178153&adtag=gzh_s_3178153_s_40390485&appid=1111677210&fid=40390485&oasis_actid=3071715&open_kuikly_info=%7B%22url%22%3A%22%3FFFROMSCHEMA%3D%26act_id%3D3071715_1111677210_AgRySq%26adtag%3Dgzh_s_3178153_s_40390485%26_gen_from%3Dqga%22%2C%22page_name%22%3A%22QQGameCenterTemplateSubscribe%22%2C%22bundle_name%22%3A%22gamecenter_template_subscribe%22%2C%22kr_turbo_display%22%3A%223071715_1111677210_AgRySq%22%2C%22kr_min_res_version%22%3A%2214720%22%7D&page_name=QQGameCenterTemplateSubscribe&pubAccountAppid=1111677210&qqplay=1&qqplayHide=1&restag=3178153',
    },
  },
  prompt: '不开电脑，也能打瓦',
  sourceName: '1111677210',
  ver: '0.0.3.67',
  view: 'pubAdArkView',
  config: {
    ctime: 1786649036,
    token: '29f389ac1df09213afc922024fbe6fb0',
  },
};

/**
 * QQ Mail notification card with `view: "mail"`.
 */
export const SAMPLE_MAIL_NOTIFICATION: ArkPayload = {
  app: 'com.tencent.template.public',
  meta: {
    mail: {
      title: 'H3CoF6',
      subTitle: '[H3CoF6/SnowLuma] Run failed: Dev Build - dev (ece288f)',
      content:
        '    [H3CoF6/SnowLuma] Dev Build workflow run          Dev Build: Some jobs were not successful       View workflow run       StatusJobAnnotations',
      detailDesc: '邮件详情',
      mailUrl:
        'https://wx.mail.qq.com/list/readtemplate?name=qq_login_jump.html&mailid=ZC0014_dj_N_a~MnFAuD2oAG2Hkq10',
      mailUrlByCode:
        'https://wx.mail.qq.com/login/login?auth_type=7&qq_target=clientreadmail&return_target=9&mailid=ZC0014_dj_N_a~MnFAuD2oAG2Hkq10&_wv=7',
    },
  },
  prompt: 'H3CoF6: [H3CoF6/SnowLuma] Run failed: Dev Build - dev (ece288f)',
  ver: '0.0.0.1',
  view: 'mail',
  config: {
    ctime: 1786651639,
    token: 'b3a39f72ec1bb6f95ce37fa1d1af6f10',
  },
};

/**
 * Single-picture ad card with `view: "singlePic"`.
 */
export const SAMPLE_SINGLE_PIC_AD: ArkPayload = {
  app: 'com.tencent.template.public',
  desc: '',
  meta: {
    singlePic: {
      banner:
        'https://tianquan.gtimg.cn/shoal/vaclient/7224e682-1d74-4144-8f54-661e9113905f.png',
      bannerUrl:
        'https://club.vip.qq.com/mono/web/novel/reader?enteranceId=pcgzh&bookId=1117301994&trace_detail=base64-eyJhcHBpZCI6InBjX2d6aCIsInBhZ2VfaWQiOiIxMDEiLCJpdGVtX2lkIjoiMjkzNDUyMCIsInB1YmxpY19hY2NvdW50X3R5cGUiOiIxIiwiZm9vdGFnZV9pZCI6IiIsImJvb2tfaWQiOiIxMTE3MzAxOTk0In0%3D',
      singlePicItems: [
        {
          jumpUrl1:
            'https://club.vip.qq.com/mono/web/novel/reader?enteranceId=pcgzh&bookId=1117301994&trace_detail=base64-eyJhcHBpZCI6InBjX2d6aCIsInBhZ2VfaWQiOiIxMDEiLCJpdGVtX2lkIjoiMjkzNDUyMCIsInB1YmxpY19hY2NvdW50X3R5cGUiOiIxIiwiZm9vdGFnZV9pZCI6IiIsImJvb2tfaWQiOiIxMTE3MzAxOTk0In0%3D',
          label1: '隐婚娇妻野性难驯，甜蜜互宠撩翻全场',
          text1: '立即阅读',
        },
      ],
      useSameSinglePicItemsKey: 'false',
    },
  },
  prompt: '隐婚娇妻野性难驯，甜蜜互宠撩翻全场',
  ver: '0.0.2.10',
  view: 'singlePic',
  config: {
    ctime: 1786464335,
    token: 'b058da4c3c1d4acdb2d8e64ca9754d81',
  },
};

/**
 * Security warning card with `view: "message"`.
 */
export const SAMPLE_SECURITY_MESSAGE: ArkPayload = {
  app: 'com.tencent.security.message',
  desc: '已登录设备风险提醒',
  meta: {
    message: {
      adv_id: '',
      bottomText: '',
      details: [
        {
          detail_color1: '',
          detail_content1: '设备存在外挂或其他软件影响QQ正常使用',
          detail_title1: '风险类型',
        },
        {
          detail_color2: '',
          detail_content2: '2109119BC',
          detail_title2: '设备名称',
        },
        {
          detail_color3: '',
          detail_content3: 'QQ桌面版-Linux',
          detail_title3: '登录应用',
        },
        {
          detail_color4: '',
          detail_content4: '2026-03-15 18:07:12',
          detail_title4: '最后登录',
        },
        {
          detail_color5: '',
          detail_content5: '',
          detail_title5: '',
        },
        {
          detail_color6: '',
          detail_content6: '',
          detail_title6: '',
        },
        {
          detail_color7: '',
          detail_content7: '',
          detail_title7: '',
        },
      ],
      headerIcon: 'https://tianshu.gtimg.cn/tianshu/1676602223556.png',
      links: [
        {
          link_title1: '查看相关安全案例',
          link_url1: 'https://mp.weixin.qq.com/s/KlLeXhoZDsCHC6BCTtpV5Q',
        },
        {
          link_title2: '修改密码',
          link_url2:
            'https://accounts.qq.com/cn2/change_psw/mobile/mobile_change_psw_way?source_id=3259',
        },
      ],
      title: '已登录设备风险提醒',
      topText:
        '你登录过的设备存在安全隐患，为了你的账号及资产安全，请确认该设备是否存在异常。建议你重新安装并使用官方版本QQ，如非本人操作请尽快修改密码，避免账号被他人盗取用作违法违规行为。',
    },
  },
  prompt: '已登录设备风险提醒',
  ver: '1.0.0.8',
  view: 'message',
  config: {
    ctime: 1783939936,
    token: 'c8caf8c7c1353e904e36ad65eba0db5f',
  },
};

/**
 * QQ Wallet notification card with `view: "genericMessageView"`.
 */
export const SAMPLE_QIANBAO_MESSAGE: ArkPayload = {
  app: 'com.tencent.qianbao',
  view: 'genericMessageView',
  desc: '',
  prompt: 'QQ钱包账户恢复通知',
  ver: '1.0.0.72',
  meta: {
    message: {
      title: 'QQ钱包账户恢复通知',
      _blackHole_: '2026/08/11',
      content: '你的QQ钱包账户已排除了安全风险并由保护模式切换至正常模式。',
      informationList: [{ label: '恢复时间', text: '2026/08/11 02:02' }],
      __blackHole__: '',
    },
  },
  config: {
    round: 1,
    autosize: 1,
    ctime: 1786384952,
    token: '246f710b21aed3f2d8ca85980cbb4e2b',
  },
};

/**
 * Multi-picture news card with `view: "multiPic"`.
 */
export const SAMPLE_MULTI_PIC_NEWS: ArkPayload = {
  app: 'com.tencent.template.public',
  desc: '',
  meta: {
    multiPic: {
      banner:
        'https://inews.gtimg.com/om_ls/O5IULUKUKX4IBK9EJCFZBZGOz8c9XLObGqkhyU_70CXpcAA_870492/0',
      bannerText:
        '"一条大河波浪宽"成绝唱，97岁郭兰英离世，留下《白毛女》等经典作品',
      bannerUrl:
        'https://h5.vip.qq.com/p/cgireport/cgi-bin/handle?adId=3228072&posId=180&reportKey=vab_push&classIndex=5&policyId=12823763&url=https%3A%2F%2Fview.inews.qq.com%2Fq%2F20260812V059A000%3Fbat_id%3D1100339139%26strategy%3Dfeature%26trace_detail%3Dbase64-eyJhcHBpZCI6InZhYl9wdXNoIiwicGFnZV9pZCI6IjE4MCIsIml0ZW1faWQiOiIzMjI4MDcyIiwiaXRlbV90eXBlIjoiNSJ9%26h5costreport%3D1&signDetail=82602ab641177a191484',
      multiPicItems: null,
      useSameMultiPicItemsKey: 'false',
    },
  },
  prompt: '"蔡徐坤进行曲"一夜爆火！短短几天播放32亿，全网都在跳',
  ver: '0.0.2.10',
  view: 'multiPic',
  config: {
    ctime: 1786520018,
    token: '5cc0162a03dd20fb774621076e70338c',
  },
};

/**
 * QQ VIP single-pic ad card with `view: "singlepic"` (lowercase).
 */
export const SAMPLE_QQVIP_SINGLEPIC: ArkPayload = {
  app: 'com.tencent.qqvip.public',
  desc: '',
  meta: {
    singlepic: {
      DATA10: '立即前往',
      DATA11:
        'https://h5.vip.qq.com/p/cgireport/cgi-bin/handle?adId=2489015&posId=85&reportKey=vab_push&classIndex=11&url=https%3A%2F%2Fact.qzone.qq.com%2Fv2%2Fvip%2Ftx%2Fp%2F55040_c7f4c20b%3Fopen_kuikly_info%3D%257B%2522bundle_name%2522%253A%2522tianxuan_activity%2522%257D%26page_name%3Dtianxuan_activity%26act_id%3D55040_c7f4c20b%26kr_turbo_display%3D55040_c7f4c20b%26enteranceId%3Dqqgzh%26_wv%3D16777216%26trace_detail%3Dbase64-eyJhcHBpZCI6InZhYl9wdXNoIiwicGFnZV9pZCI6Ijg1IiwiaXRlbV9pZCI6IjI0ODkwMTUiLCJpdGVtX3R5cGUiOiI1IiwiYWRfaWQiOiIzMjA0NDczIiwiZm9vdGFnZV9pZCI6IjE4MTkzMTAifQ%3D%3D%26h5costreport%3D1&signDetail=7372aa24dde56b710499',
      DATA7: 'https://tianshu.gtimg.cn/tianshu/1784775994628.png',
      DATA8:
        'https://h5.vip.qq.com/p/cgireport/cgi-bin/handle?adId=2489015&posId=85&reportKey=vab_push&classIndex=8&url=https%3A%2F%2Fact.qzone.qq.com%2Fv2%2Fvip%2Ftx%2Fp%2F55040_c7f4c20b%3Fopen_kuikly_info%3D%257B%2522bundle_name%2522%253A%2522tianxuan_activity%2522%257D%26page_name%3Dtianxuan_activity%26act_id%3D55040_c7f4c20b%26kr_turbo_display%3D55040_c7f4c20b%26enteranceId%3Dqqgzh%26_wv%3D16777216%26trace_detail%3Dbase64-eyJhcHBpZCI6InZhYl9wdXNoIiwicGFnZV9pZCI6Ijg1IiwiaXRlbV9pZCI6IjI0ODkwMTUiLCJpdGVtX3R5cGUiOiI1IiwiYWRfaWQiOiIzMjA0NDczIiwiZm9vdGFnZV9pZCI6IjE4MTkzMTAifQ%3D%3D%26h5costreport%3D1&signDetail=377f4aad6b72134f89e2',
      DATA9: 'SVIP+QQ阅读双年卡特惠低至318元！',
      time: '1786384547',
    },
  },
  prompt: 'SVIP+QQ阅读双年卡特惠低至318元！',
  ver: '',
  view: 'singlepic',
  config: {
    ctime: 1786384547,
    token: '28032ff966a07854e0654c72aee01010',
  },
};
