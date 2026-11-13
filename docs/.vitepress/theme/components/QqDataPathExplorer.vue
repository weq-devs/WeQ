<template>
  <div class="weq-tool">
    <p class="weq-tool-title">QQ 数据目录速查</p>
    <p class="weq-tool-desc">
      三端账号目录的命名规则不一样：Windows 是 <code>&lt;数据根&gt;/&lt;QQ号&gt;/nt_qq</code>，
      Linux / macOS 是 <code>&lt;数据根&gt;/nt_qq_&lt;md5(md5(uid) + "nt_kernel")&gt;</code>。
      填 uid 就能一步算出所有资源的绝对路径。
    </p>

    <div class="weq-tool-grid">
      <div class="weq-tool-field">
        <label for="path-platform">平台</label>
        <select id="path-platform" v-model="platform" @change="onPlatform">
          <option value="win32">Windows</option>
          <option value="linux">Linux</option>
          <option value="darwin">macOS</option>
        </select>
      </div>
      <div class="weq-tool-field">
        <label for="path-root">QQ 数据根</label>
        <input id="path-root" v-model="root" spellcheck="false" @input="compute" />
      </div>
      <div class="weq-tool-field">
        <label for="path-uin">QQ 号（uin）</label>
        <input id="path-uin" v-model="uin" spellcheck="false" placeholder="10001" @input="compute" />
      </div>
      <div class="weq-tool-field">
        <label for="path-uid">uid（u_ 开头）</label>
        <input id="path-uid" v-model="uid" spellcheck="false" placeholder="u_xxxxxxxx" @input="compute" />
      </div>
    </div>

    <p class="weq-tool-hint">
      uid 在 <code>profile_info.db</code> 的 <code>profile_info_v6</code> 里，
      或在账号目录名、<code>gpro_v1-6_&lt;uid&gt;.db</code> 的文件名里都能看到。
      只知道 QQ 号时，macOS / Linux 的账号目录需要 uid 才能算。
    </p>

    <p v-if="error" class="weq-tool-error">{{ error }}</p>

    <div v-if="rows.length" class="weq-tool-out">
      <div v-for="row in rows" :key="row.key" class="weq-tool-row">
        <span class="weq-tool-key">{{ row.key }}</span>
        <span class="weq-tool-val">{{ row.value }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { md5Hex } from '../utils/digest.ts';

const DEFAULTS = {
  win32: String.raw`C:\Users\<用户名>\Documents\Tencent Files`,
  linux: '~/.config/QQ',
  darwin: '~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ',
};

const platform = ref('win32');
const root = ref(DEFAULTS.win32);
const uin = ref('');
const uid = ref('');
const error = ref('');

const sep = computed(() => (platform.value === 'win32' ? '\\' : '/'));

/** 账号目录：Windows 是 `<uin>/nt_qq`，Linux/macOS 是 `nt_qq_<hash(uid)>`。 */
const accountDir = computed(() => {
  const base = root.value.replace(/[\\/]+$/, '');
  if (platform.value === 'win32') {
    return uin.value ? `${base}${sep.value}${uin.value}${sep.value}nt_qq` : '';
  }
  if (!uid.value) return '';
  const inner = md5Hex(uid.value);
  return `${base}${sep.value}nt_qq_${md5Hex(`${inner}nt_kernel`)}`;
});

const rows = computed(() => {
  const dir = accountDir.value;
  if (!dir) return [];
  const p = sep.value;
  const join = (...parts) => [dir, ...parts].join(p);
  const rootPath = root.value.replace(/[\\/]+$/, '');
  const list = [
    { key: '账号目录', value: dir },
    { key: 'nt_msg.db', value: join('nt_db', 'nt_msg.db') },
    { key: 'profile_info.db', value: join('nt_db', 'profile_info.db') },
    { key: 'group_info.db', value: join('nt_db', 'group_info.db') },
    { key: 'emoji.db', value: join('nt_db', 'emoji.db') },
    { key: 'nt_data', value: join('nt_data') },
    { key: '头像缓存', value: join('nt_data', 'avatar') },
    { key: '商城表情', value: join('nt_data', 'Emoji', 'marketface') },
    { key: '收藏表情 / 自定义表情', value: join('nt_data', 'Emoji', 'personal_emoji') },
    { key: '内置表情资源', value: join('nt_data', 'Emoji', 'BaseEmojiSyastems') },
    { key: '图片 / 语音 / 视频', value: join('nt_data', 'Pic') },
  ];
  if (platform.value === 'win32') {
    list.push({
      key: 'login.db',
      value: `${rootPath}${p}nt_qq${p}global${p}nt_db${p}login.db`,
    });
  } else {
    list.push({ key: 'login.db（主）', value: `${rootPath}${p}global${p}nt_db${p}login.db` });
    list.push({
      key: 'login.db（备）',
      value: `${rootPath}${p}nt_qq${p}global${p}nt_db${p}login.db`,
    });
  }
  return list;
});

function onPlatform() {
  root.value = DEFAULTS[platform.value];
  compute();
}

function compute() {
  error.value = '';
  if (platform.value === 'win32' && !/^\d+$/.test(uin.value.trim())) {
    uin.value = uin.value.trim();
    if (uin.value) error.value = 'Windows 的账号目录用的是纯数字 QQ 号。';
  }
  if (platform.value !== 'win32' && uid.value && !uid.value.trim().startsWith('u_')) {
    error.value = 'uid 一般是 `u_` 开头的一串字符；确认没填成 QQ 号。';
  }
  uin.value = uin.value.trim();
  uid.value = uid.value.trim();
}
</script>
