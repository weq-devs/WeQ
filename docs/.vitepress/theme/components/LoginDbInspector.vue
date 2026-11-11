<template>
  <div class="weq-tool">
    <p class="weq-tool-title">login.db 在线检查</p>
    <p class="weq-tool-desc">
      把本机的 <code>login.db</code> 拖进来，先在浏览器里看清它到底是什么布局、密钥该从哪来，
      再决定用哪条链路解密。文件不会离开浏览器，也不会上传。
    </p>

    <div class="weq-tool-field">
      <label for="login-db-file">选择 login.db</label>
      <input id="login-db-file" type="file" @change="onFile" />
    </div>

    <div class="weq-tool-grid" style="margin-top: 12px">
      <div class="weq-tool-field">
        <label for="login-db-uid">nt_uid（可选）</label>
        <input id="login-db-uid" v-model="uid" spellcheck="false" placeholder="u_..." @input="computeKeys" />
      </div>
      <div class="weq-tool-field">
        <label for="login-db-rand">rand（可选，8 位）</label>
        <input id="login-db-rand" v-model="rand" spellcheck="false" placeholder="6tPaJ9GP" @input="computeKeys" />
      </div>
    </div>

    <p class="weq-tool-hint">
      库布局：Windows 是 <code>&lt;数据根&gt;/nt_qq/global/nt_db/login.db</code>；
      Linux / macOS 主库在 <code>&lt;数据根&gt;/global/nt_db/login.db</code>，
      另有一份较小的副本在 <code>&lt;数据根&gt;/nt_qq/global/nt_db/login.db</code>，两份都要读。
    </p>

    <p v-if="error" class="weq-tool-error">{{ error }}</p>

    <div v-if="rows.length" class="weq-tool-out">
      <div v-for="row in rows" :key="row.key" class="weq-tool-row">
        <span class="weq-tool-key">{{ row.key }}</span>
        <span class="weq-tool-val">{{ row.value }}</span>
      </div>
    </div>

    <div v-if="keys.length" class="weq-tool-out">
      <p class="weq-tool-desc" style="margin-bottom: 8px">
        候选密钥（按手机 QQ 的离线公式算的，本机桌面库大概率不适用，只用于判断这份库是不是从手机拷来的）：
      </p>
      <div v-for="item in keys" :key="item.label" class="weq-tool-row">
        <span class="weq-tool-key">{{ item.label }}</span>
        <span class="weq-tool-val">{{ item.value }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { md5Hex } from '../utils/digest.ts';

const rows = ref([]);
const keys = ref([]);
const error = ref('');
const uid = ref('');
const rand = ref('');

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
const ascii = (bytes) =>
  Array.from(bytes, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');

function computeKeys() {
  keys.value = [];
  const id = uid.value.trim();
  const r = rand.value.trim();
  if (!id || r.length !== 8) return;
  const uidHash = md5Hex(id);
  keys.value = [
    { label: 'QQ_path_hash', value: md5Hex(`${uidHash}nt_kernel`) },
    { label: '数据库密钥', value: md5Hex(`${uidHash}${r}`) },
  ];
}

async function onFile(event) {
  rows.value = [];
  error.value = '';
  const file = event.target.files?.[0];
  if (!file) return;

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < 64) {
    error.value = '文件太小，不像是 SQLite 库。';
    return;
  }

  // QQ 库在 SQLCipher 页前叠了 1024 字节私有头；标准布局没有这一段。
  const header = bytes.slice(0, 16);
  const looksPlain = ascii(bytes.slice(0, 15)) === 'SQLite format 3';
  const qqLayout = !looksPlain;
  const pageOffset = qqLayout ? 1024 : 0;
  const salt = bytes.slice(pageOffset, pageOffset + 16);
  const printable = salt.every((b) => b >= 0x20 && b < 0x7f);

  rows.value = [
    { key: '文件名', value: file.name },
    { key: '大小', value: `${bytes.length} 字节` },
    { key: '布局', value: qqLayout ? 'QQ 布局（页前有 1024 字节私有头）' : '标准 SQLite 布局' },
    { key: '页起始偏移', value: String(pageOffset) },
    { key: '文件头 16 字节', value: hex(header) },
    { key: '可打印形式', value: ascii(header) },
    { key: 'salt（前 16 字节）', value: `${hex(salt)}${printable ? ` · "${ascii(salt)}"` : ''}` },
    {
      key: '下一步',
      value: qqLayout
        ? '用 WeQ「密钥扫描 / 数据库修复」取 raw key，或用 decryptLoginDb 读账号列表'
        : '这份已经是明文库，任何 SQLite 工具都能直接打开',
    },
  ];

  if (printable && uid.value.trim()) {
    rows.value.push({
      key: '提示',
      value:
        '前 16 字节是可打印字符，说明它更像手机库的 rand 段；如果是手机拷来的，填 uid 和这段字符再算一次。',
    });
  }
}
</script>
