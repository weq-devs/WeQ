# 支持的 QQ 版本

WeQ 依赖 QQ 客户端里的签名器才能取到数据库密钥，而签名器在每个 QQ 版本里的位置都可能变化。下面的清单是**已经跑过签名兼容性验证**的版本：WeQ 的原生模块能在这些 QQ 构建上正确定位签名器。

清单由 CI 每晚从 QQ 官网抓取最新版本、下载安装包验证后自动更新，不需要手动维护。验证通过只代表签名器定位兼容；具体功能有没有差异，仍以实际使用为准。

## 当前支持状态

<script setup>
import { data } from '../.vitepress/data/supported-versions.data.ts';

const statusText = {
  current: '已对齐官网最新',
  outdated: '已验证旧版本',
  verified: '已验证',
  none: '暂未验证',
};
</script>

<table>
  <thead>
    <tr>
      <th>平台</th>
      <th>官网最新版本</th>
      <th>已验证版本</th>
      <th>验证时间</th>
      <th>状态</th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="row in data.rows" :key="row.key">
      <td>{{ row.label }}</td>
      <td>
        {{ row.latest ?? '—' }}
        <template v-if="row.latestDate">（{{ row.latestDate }}）</template>
      </td>
      <td>{{ row.verified ?? '—' }}</td>
      <td>{{ row.verifiedAt ?? '—' }}</td>
      <td :class="['version-status', `version-status--${row.status}`]">{{ statusText[row.status] }}</td>
    </tr>
  </tbody>
</table>

<p v-if="data.rows.some((row) => row.stale)" class="version-note">
  ⚠️ 部分平台的官网版本可能因 CDN 灰度短暂回退，清单按已记录的新版本为准。
</p>

## 待验证版本

官网已经发布、但签名兼容性还没验证完的版本。可以尝鲜；遇到无法取密钥或原生模块报错时，请先换回下面「全部验证记录」里的版本。

<p v-if="data.pending.length === 0" class="version-empty">当前没有待验证版本，官网最新版本都已有验证记录。</p>

<table v-else>
  <thead>
    <tr>
      <th>平台</th>
      <th>待验证版本</th>
      <th>官网当前版本</th>
      <th>发现时间</th>
    </tr>
  </thead>
  <tbody>
    <tr v-for="item in data.pending" :key="`${item.platform}:${item.version}`">
      <td>{{ item.label }}</td>
      <td>{{ item.version }}</td>
      <td>{{ item.latest ?? '—' }}</td>
      <td>{{ item.discoveredAt ?? '—' }}</td>
    </tr>
  </tbody>
</table>

## 全部验证记录

所有验证通过的版本都会留档，不只看最新一版。旧版本仍可能可用，但建议升级到对应平台的最新已验证版本。

<table>
  <thead>
    <tr>
      <th>平台</th>
      <th>版本</th>
      <th>验证时间</th>
      <th>备注</th>
    </tr>
  </thead>
  <tbody>
    <template v-for="row in data.rows" :key="row.key">
      <tr v-for="entry in row.history" :key="`${row.key}:${entry.version}`">
        <td>{{ row.label }}</td>
        <td>{{ entry.version }}</td>
        <td>{{ entry.verifiedAt || '—' }}</td>
        <td>{{ entry.version === row.verified ? '当前已验证版本' : '历史版本' }}</td>
      </tr>
    </template>
  </tbody>
</table>

## 清单从哪来

- 已验证清单：[`versions/supported.json`](https://github.com/weq-devs/WeQ/blob/main/versions/supported.json)
- 官网最新版本：[`versions/latest.json`](https://github.com/weq-devs/WeQ/blob/main/versions/latest.json)
- 最近一次抓取时间：{{ data.fetchedAt ?? '未知' }}（北京时间）

清单每晚自动更新；最近一次更新以仓库里这两个文件的提交记录为准。你的 QQ 版本不在列表里时，先升级到官网最新版再试；如果最新版也取不到密钥，请带上 QQ 版本号和系统信息到 [Issue](https://github.com/weq-devs/WeQ/issues) 反馈。

<style scoped>
.version-status {
  white-space: nowrap;
}
.version-status--current {
  color: var(--vp-c-green-1);
}
.version-status--outdated,
.version-status--verified {
  color: var(--vp-c-yellow-1);
}
.version-status--none {
  color: var(--vp-c-text-3);
}
.version-note,
.version-empty {
  color: var(--vp-c-text-2);
}
</style>
