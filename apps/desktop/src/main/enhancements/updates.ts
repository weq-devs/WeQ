import { networkFetch } from '@weq/network';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import { z } from 'zod';
import {
  writeFileAtomic,
  parseDressIndexManifest,
  type ModelEntry,
  type UserConfigService,
} from '@weq/service';
import { onSettingsChanged } from '@weq/service/settings-changes';
import { networkScope, transferBehavior } from '@weq/service/network-scope';
import { TransferGate, allowNetwork } from '@weq/service/data-saver';
import { watchTransferPolicy, transferRestricted } from '@weq/service/transfer-policy';
import { UpdateCheckScheduler } from '../update/scheduler';
import { getReleaseFeed } from '../update/release_feed';
import { fetchSourceJson } from '@weq/network';
import {
  ENHANCEMENT_PACK_IDS,
  parseEnhancementEngineManifest,
  type EnhancementPackId,
} from '../../shared/enhancement_manifest';
import {
  parseEnhancementCatalogForHost,
  enhancementReleaseBlocker,
  type EnhancementCatalog,
  type EnhancementRelease,
  type EnhancementUpdateNotice,
} from '../../shared/enhancement_release';
import { createEnhancementCatalog, createRelease, releaseContentVersion } from './release_catalog';
import { enhancementTaskNeedsInput, startEnhancementDownloads } from './tasks';
import type { EnhancementPacks } from './packs';

export interface EnhancementCheckState {
  phase: 'unchecked' | 'checking' | 'waiting-network' | 'checked' | 'failed';
  checkedAt?: number;
  error?: string;
  pauseReasons?: string[];
}
const releaseList = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    published_at: z.string().nullable(),
    assets: z.array(z.object({ name: z.string() })),
  }),
);
const CHECK_PAUSED = new Error('enhancement check paused');

export class EnhancementUpdateController {
  private readonly states = new Map<EnhancementPackId, EnhancementCheckState>();
  private readonly latest = new Map<EnhancementPackId, EnhancementRelease>();
  private readonly fresh = new Set<EnhancementPackId>();
  private readonly notifiedVersions = new Map<EnhancementPackId, string>();
  private notifications: EnhancementUpdateNotice[] = [];
  private readonly notificationListeners = new Set<(notices: EnhancementUpdateNotice[]) => void>();
  private saving = Promise.resolve();
  private readonly scheduler: UpdateCheckScheduler;
  private readonly loaded: Promise<void>;
  private pending?: Promise<void>;
  private pendingIds = new Set<EnhancementPackId>();
  private continueCheck?: () => void;
  private forceCheck = false;
  private gate?: TransferGate;
  private readonly requests = new Set<AbortController>();
  private readonly feeds = new Map<string, { etag: string; value: unknown }>();
  private readonly abort = new AbortController();
  private stopSettings?: () => void;
  private stopSettled?: () => void;
  private scheduleKey = '';
  private readonly path: string;
  constructor(
    private readonly packs: EnhancementPacks,
    private readonly config: UserConfigService,
    private readonly target: string,
    private readonly options: {
      currentVersion: () => string;
      nativeCommit: () => string | undefined;
      fetcher?: typeof fetch;
      localDress?: () => boolean;
      legacyModels?: ModelEntry[];
    },
  ) {
    this.path = join(config.appDataRoot(), 'enhancements/checks.json');
    this.scheduler = new UpdateCheckScheduler(() => this.check(ENHANCEMENT_PACK_IDS, true));
    this.loaded = readFile(this.path, 'utf8')
      .then((text) => {
        const cached = JSON.parse(text);
        const catalog = parseEnhancementCatalogForHost(
          cached.catalog,
          this.options.currentVersion(),
          target,
        );
        if (catalog.target !== target) return;
        if (
          catalog.packs.some(
            (entry) =>
              !entry.unavailable &&
              entry.contentVersion !== releaseContentVersion(entry.components),
          )
        )
          throw new Error('增强包缓存内容身份无效');
        for (const entry of catalog.packs) {
          this.latest.set(entry.id, entry);
          // 旧版已知的内容作为迁移基线，不因 WeQ 本身升级重新提醒。
          const notified =
            cached.notifiedVersions === undefined
              ? entry.contentVersion
              : cached.notifiedVersions?.[entry.id];
          if (typeof notified === 'string') this.notifiedVersions.set(entry.id, notified);
        }
        for (const id of ENHANCEMENT_PACK_IDS) {
          this.states.set(
            id,
            z
              .object({
                phase: z.enum(['unchecked', 'checking', 'waiting-network', 'checked', 'failed']),
                checkedAt: z.number().optional(),
                error: z.string().optional(),
              })
              .parse(cached.states?.[id] ?? { phase: 'unchecked' }),
          );
        }
      })
      .catch(() => {})
      .then(() => {
        for (const entry of this.latest.values()) this.apply(entry);
      });
    packs.setReleaseResolver(async (id) => {
      await this.loaded;
      if (!this.fresh.has(id)) {
        try {
          await this.check([id]);
        } catch (error) {
          // 仅复用曾从线上校验并保存的描述；首次离线不猜下载地址。
          if (!this.latest.has(id)) throw error;
        }
      }
      const entry = this.latest.get(id);
      if (!entry) throw new Error('尚未取得此增强包的在线清单，请重试检查');
      this.apply(entry);
    });
  }
  private apply(entry: EnhancementRelease) {
    if (
      entry.id === 'dress' &&
      this.options.localDress?.() &&
      !entry.unavailable &&
      semver.valid(this.options.currentVersion()) &&
      semver.gte(this.options.currentVersion(), entry.minWeqVersion)
    ) {
      this.packs.selectRelease(entry, '本地源码索引随原生模块管理', false);
      return;
    }
    this.packs.selectRelease(
      entry,
      enhancementReleaseBlocker(entry, this.options.currentVersion(), this.options.nativeCommit()),
    );
  }
  async ready() {
    await this.loaded;
  }
  async wait() {
    await this.pending?.catch(() => {});
  }
  state(id: EnhancementPackId) {
    return this.states.get(id) ?? { phase: 'unchecked' as const };
  }
  subscribeNotifications(listener: (notices: EnhancementUpdateNotice[]) => void) {
    this.notificationListeners.add(listener);
    listener(this.notifications);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }
  async acknowledgeNotifications(
    notices: readonly Pick<EnhancementUpdateNotice, 'id' | 'contentVersion'>[],
  ) {
    await this.loaded;
    for (const notice of notices)
      if (
        this.notifications.some(
          (entry) => entry.id === notice.id && entry.contentVersion === notice.contentVersion,
        )
      )
        this.notifiedVersions.set(notice.id, notice.contentVersion);
    await this.save();
    await this.refreshNotifications();
  }
  private async refreshNotifications() {
    this.notifications = (await this.packs.list())
      .filter(
        (pack) =>
          this.fresh.has(pack.id) &&
          this.state(pack.id).phase === 'checked' &&
          pack.installed &&
          pack.updateAvailable &&
          !pack.busy &&
          !pack.blocker &&
          pack.latestVersion &&
          pack.latestVersion !== pack.installedVersion &&
          this.notifiedVersions.get(pack.id) !== pack.latestVersion,
      )
      .map((pack) => ({ id: pack.id, name: pack.name, contentVersion: pack.latestVersion! }));
    for (const listener of this.notificationListeners) listener(this.notifications);
  }
  start() {
    if (this.stopSettings || this.abort.signal.aborted) return;
    const configure = () => {
      const settings = this.config.getSettings();
      const key = JSON.stringify([
        settings.enhancementUpdates,
        settings.updateCheckIntervalMinutes,
        settings.updateCheckPrerelease,
      ]);
      if (key === this.scheduleKey) return;
      const startup = this.scheduleKey === '';
      this.scheduleKey = key;
      this.scheduler.configure(
        settings.enhancementUpdates.autoCheck ? settings.updateCheckIntervalMinutes : -1,
        startup,
      );
    };
    this.stopSettings = onSettingsChanged(configure);
    this.stopSettled = this.packs.onSettled(() => {
      void this.installKnown(ENHANCEMENT_PACK_IDS).catch(() => {});
    });
    configure();
    void this.loaded.then(() => this.packs.reconcileExisting());
  }
  stop() {
    this.scheduler.stop();
    this.stopSettings?.();
    this.stopSettled?.();
    this.stopSettled = undefined;
    this.stopSettings = undefined;
    this.notificationListeners.clear();
    this.abort.abort();
  }

  check(ids: readonly EnhancementPackId[], automatic = false): Promise<void> {
    if (this.pending) {
      if (!automatic) {
        this.forceCheck = true;
        this.continueCheck?.();
      }
      const missing = ids.filter((id) => !this.pendingIds.has(id));
      return missing.length
        ? this.pending.catch(() => {}).then(() => this.check(missing, automatic))
        : this.pending;
    }
    const requested = [...new Set(ids)];
    this.pendingIds = new Set(requested);
    this.pending = this.performCheck(requested, automatic).finally(() => {
      this.pending = undefined;
      this.gate = undefined;
      this.continueCheck = undefined;
      this.forceCheck = false;
      this.pendingIds.clear();
    });
    return this.pending;
  }
  private async performCheck(ids: EnhancementPackId[], automatic: boolean) {
    await this.loaded;
    if (automatic && !this.config.getSettings().enhancementUpdates.autoCheck) return;
    for (const id of ids) this.fresh.delete(id);
    const gate = new TransferGate();
    this.gate = gate;
    if (this.forceCheck) gate.continue();
    let policyPaused = false;
    const updatePolicy = () => {
      const waiting =
        automatic && !allowNetwork(transferRestricted(), 'prefetch', transferBehavior());
      if (policyPaused && !waiting && !transferBehavior().dataSaverAutoResume)
        gate.restrict('resume-required', true);
      if (!waiting && transferBehavior().dataSaverAutoResume)
        gate.restrict('resume-required', false);
      policyPaused = waiting;
      gate.restrict('network', waiting);
      if (gate.paused) for (const request of this.requests) request.abort(CHECK_PAUSED);
      for (const id of ids)
        this.states.set(id, {
          ...this.state(id),
          phase: gate.paused ? 'waiting-network' : 'checking',
          pauseReasons: gate.pauseReasons,
          error: undefined,
        });
    };
    this.continueCheck = () => {
      gate.continue();
      updatePolicy();
    };
    const unwatch = watchTransferPolicy(updatePolicy);
    try {
      updatePolicy();
      await gate.wait(this.abort.signal);
      for (const packId of ids)
        this.states.set(packId, { ...this.state(packId), phase: 'checking', error: undefined });
      const results = await Promise.allSettled([
        ids.some((id) => id !== 'dress')
          ? this.fetchCatalog('weq-devs/WeQ', `enhancement-packs-${this.target}.json`)
          : Promise.resolve(null),
        ids.includes('dress')
          ? this.fetchCatalog('weq-devs/dress-resources', 'enhancement-pack.json')
          : Promise.resolve(null),
      ]);
      const errors: string[] = [];
      for (const packId of ids) {
        const result = results[packId === 'dress' ? 1 : 0]!;
        const entry =
          result.status === 'fulfilled'
            ? result.value?.packs.find((entry) => entry.id === packId)
            : undefined;
        if (!entry) {
          const error =
            result.status === 'rejected'
              ? String(result.reason instanceof Error ? result.reason.message : result.reason)
              : '发布清单未包含此增强包';
          this.states.set(packId, { ...this.state(packId), phase: 'failed', error });
          errors.push(error);
          continue;
        }
        if (!entry.unavailable && entry.contentVersion !== releaseContentVersion(entry.components))
          throw new Error('增强包内容版本与文件清单不一致');
        this.latest.set(packId, entry);
        this.fresh.add(packId);
        this.apply(entry);
        this.states.set(packId, { phase: 'checked', checkedAt: Date.now() });
      }
      await this.save();
      this.abort.signal.throwIfAborted();
      await this.installKnown(ids);
      await this.refreshNotifications();
      if (errors.length) throw new Error([...new Set(errors)].join('；'));
    } catch (error) {
      for (const id of ids)
        if (this.state(id).phase === 'checking' || this.state(id).phase === 'waiting-network')
          this.states.set(id, {
            ...this.state(id),
            phase: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
      if (!this.abort.signal.aborted) await this.save().catch(() => {});
      throw error;
    } finally {
      unwatch();
    }
  }
  private async fetchJson(url: string) {
    for (;;) {
      await this.gate?.wait(this.abort.signal);
      const request = new AbortController();
      this.requests.add(request);
      try {
        const feed = this.feeds.get(url);
        const response = await (this.options.fetcher ?? networkFetch)(url, {
          signal: AbortSignal.any([this.abort.signal, request.signal, AbortSignal.timeout(8000)]),
          headers: {
            Accept: 'application/vnd.github+json',
            ...(feed ? { 'If-None-Match': feed.etag } : {}),
          },
        });
        if (response.status === 304 && feed) return feed.value;
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(`增强包检查失败（HTTP ${response.status}）`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = '';
        let bytes = 0;
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.length;
          if (bytes > (url.startsWith('https://api.github.com/') ? 8 : 2) * 1024 ** 2) {
            await reader.cancel();
            throw new Error('增强包发布清单过大');
          }
          text += decoder.decode(item.value, { stream: true });
        }
        const value: unknown = JSON.parse(text + decoder.decode());
        const etag = response.headers.get('etag');
        if (etag && url.startsWith('https://api.github.com/')) this.feeds.set(url, { etag, value });
        return value;
      } catch (error) {
        if (request.signal.reason !== CHECK_PAUSED || this.abort.signal.aborted) throw error;
      } finally {
        this.requests.delete(request);
      }
    }
  }
  private async installKnown(ids: readonly EnhancementPackId[]) {
    const settings = this.config.getSettings();
    if (
      this.abort.signal.aborted ||
      !settings.enhancementUpdates.autoCheck ||
      !settings.enhancementUpdates.autoInstall
    )
      return;
    const install = (await this.packs.list())
      .filter(
        (pack) =>
          ids.includes(pack.id) &&
          this.fresh.has(pack.id) &&
          pack.installed &&
          pack.updateAvailable &&
          !pack.busy &&
          !enhancementTaskNeedsInput(this.packs, pack.id) &&
          !pack.blocker &&
          pack.operation?.phase !== 'failed' &&
          this.state(pack.id).phase === 'checked',
      )
      .map((pack) => pack.id);
    if (install.length)
      await networkScope.run({ restricted: false, intent: 'batch' }, () =>
        startEnhancementDownloads(this.packs, install),
      );
  }
  private async fetchCatalog(repository: string, asset: string): Promise<EnhancementCatalog> {
    const feed = getReleaseFeed(repository);
    let signedIndex: Awaited<ReturnType<typeof feed.read>>;
    for (;;) {
      await this.gate?.wait(this.abort.signal);
      const request = new AbortController();
      this.requests.add(request);
      try {
        signedIndex = await feed.read(
          true,
          AbortSignal.any([this.abort.signal, request.signal]),
          this.options.fetcher ?? networkFetch,
        );
        break;
      } catch (error) {
        if (request.signal.reason !== CHECK_PAUSED || this.abort.signal.aborted) throw error;
      } finally {
        this.requests.delete(request);
      }
    }
    const data = releaseList.parse(
      signedIndex
        ? signedIndex.releases.map((release) => ({
            tag_name: release.tag,
            draft: false,
            prerelease: release.prerelease,
            published_at: release.publishedAt,
            assets: release.assets,
          }))
        : await this.fetchJson(`https://api.github.com/repos/${repository}/releases?per_page=100`),
    );
    const includePrerelease = this.config.getSettings().updateCheckPrerelease;
    const isDress = repository.endsWith('/dress-resources');
    const legacyAsset = isDress ? 'index-manifest.json' : `enhancement-engines-${this.target}.json`;
    const releases = data.filter(
      (release) =>
        !release.draft &&
        release.published_at &&
        (includePrerelease || (!release.prerelease && !semver.prerelease(release.tag_name))) &&
        release.assets.some((item) => item.name === asset || item.name === legacyAsset),
    );
    releases.sort((a, b) =>
      repository.endsWith('/WeQ') && semver.valid(a.tag_name) && semver.valid(b.tag_name)
        ? semver.rcompare(a.tag_name, b.tag_name)
        : String(b.published_at).localeCompare(String(a.published_at)),
    );
    const latest = releases[0];
    if (!latest) throw new Error('此来源尚未发布增强包更新清单');
    const unified = latest.assets.some((item) => item.name === asset);
    const baseUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(latest.tag_name)}`;
    const url = `${baseUrl}/${unified ? asset : legacyAsset}`;
    const signed = signedIndex?.releases.find((release) => release.tag === latest.tag_name)
      ?.catalogs[unified ? asset : legacyAsset];
    const parse = (input: unknown) => {
      let value = input;
      if (!unified) {
        if (isDress) {
          const manifest = parseDressIndexManifest(value);
          if (
            manifest.baseUrl !== baseUrl ||
            Object.values(manifest.parts).some(
              (part) => !latest.assets.some((item) => item.name === part.asset),
            )
          )
            throw new Error('在线装扮清单与已发布资产不匹配');
          value = {
            schemaVersion: 1,
            target: this.target,
            packs: [createRelease('dress', [{ type: 'dress', manifest }])],
          };
        } else {
          const manifest = parseEnhancementEngineManifest(value);
          if (manifest.target !== this.target) throw new Error('增强包清单平台与当前宿主不匹配');
          if (
            manifest.engines.some(
              (engine) => !latest.assets.some((item) => engine.url === `${baseUrl}/${item.name}`),
            )
          )
            throw new Error('在线引擎清单与已发布资产不匹配');
          value = createEnhancementCatalog(manifest, this.options.legacyModels ?? []);
        }
      }
      return parseEnhancementCatalogForHost(
        isDress ? { ...(value as object), target: this.target } : value,
        this.options.currentVersion(),
        this.target,
      );
    };
    if (signed) return parse(JSON.parse(signed));
    for (;;) {
      await this.gate?.wait(this.abort.signal);
      const request = new AbortController();
      this.requests.add(request);
      try {
        return await fetchSourceJson(url, parse, {
          signal: AbortSignal.any([this.abort.signal, request.signal]),
          fetcher: this.options.fetcher ?? networkFetch,
        });
      } catch (error) {
        if (request.signal.reason !== CHECK_PAUSED || this.abort.signal.aborted) throw error;
      } finally {
        this.requests.delete(request);
      }
    }
  }
  private save() {
    const text = JSON.stringify({
      states: Object.fromEntries(this.states),
      notifiedVersions: Object.fromEntries(this.notifiedVersions),
      catalog: {
        schemaVersion: 1,
        target: this.target,
        packs: [...this.latest.values()],
      },
    });
    this.saving = this.saving.catch(() => {}).then(() => writeFileAtomic(this.path, text));
    return this.saving;
  }
}
