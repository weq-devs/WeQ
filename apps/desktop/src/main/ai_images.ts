import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import {
  AiImageProcessor,
  imageDescriptionCache,
  type AiImagePort,
  type AiImageRef,
} from '@weq/agentlab';
import { ocrCacheFor, ocrCacheKey, localOcrBlocker } from '@weq/service';
import { getAppContext } from './context/app_context';
import { resolveChatImageFile } from './media_protocol';
import { prefilterAutomaticOcr } from './ocr/prefilter';
import { resolveLocalOcrModel, runLocalOcr } from './ocr/local';
import { imageMetadata } from './image_processor';

const MAX_BYTES = 32 * 1024 * 1024;
const processors = new WeakMap<object, AiImageProcessor>();
type ImageSettings = ReturnType<ReturnType<typeof context>['boot']['userConfig']['getSettings']>;
const taskImages = new AsyncLocalStorage<{
  settings: ImageSettings;
  vision: ReturnType<ReturnType<typeof context>['boot']['agentLabConfig']['resolveVisionEndpoint']>;
  localModel: ReturnType<typeof resolveLocalOcrModel>;
}>();

export function withImageTaskConfiguration<T>(run: () => Promise<T>): Promise<T> {
  const { boot } = context();
  const settings = structuredClone(boot.userConfig.getSettings());
  let vision: ReturnType<typeof boot.agentLabConfig.resolveVisionEndpoint> = null;
  try {
    vision = boot.agentLabConfig.resolveVisionEndpoint();
  } catch {
    /* 实际取图时仍可走 OCR。 */
  }
  return taskImages.run({ settings, vision, localModel: resolveLocalOcrModel() }, run);
}
function imageFormat(bytes: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' {
  if (bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.subarray(0, 3).toString() === 'GIF') return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'webp';
  throw new Error('请使用 PNG、JPEG、WebP 或 GIF 图片');
}
function context() {
  const ctx = getAppContext();
  if (!ctx.bootstrap || !ctx.services) throw new Error('请先打开账号');
  return { boot: ctx.bootstrap, svc: ctx.services };
}
function assetRoot() {
  return join(context().svc.agentLab.assetRoot, 'images');
}
export function aiImageAssetPath(name: string): string {
  if (!/^[a-f0-9]{64}\.(png|jpeg|webp|gif)$/.test(name)) throw new Error('图片素材标识无效');
  return join(assetRoot(), name);
}
async function saveAsset(
  bytes: Buffer,
  check: () => void = () => {},
): Promise<{ path: string; key: string; mime: string }> {
  const root = assetRoot();
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('图片需为 32 MiB 以内的非空文件');
  const format = imageFormat(bytes);
  await imageMetadata(bytes, 64 * 1024 * 1024);
  check();
  const key = createHash('sha256').update(bytes).digest('hex');
  const path = join(root, `${key}.${format}`);
  await mkdir(root, { recursive: true });
  check();
  await writeFile(path, bytes, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  return { path, key, mime: `image/${format}` };
}
export async function retainAiImage(path: string): Promise<AiImageRef & { path: string }> {
  const { svc } = context();
  const trusted = await svc.fileResource.resolveLocalFile(path);
  if (!trusted) throw new Error('请选择或上传图片');
  if ((await stat(trusted)).size > MAX_BYTES) throw new Error('图片超过 32 MiB');
  const bytes = await readFile(trusted);
  if (context().svc !== svc) throw new Error('账号已切换');
  const saved = await saveAsset(bytes, () => {
    if (context().svc !== svc) throw new Error('账号已切换');
  });
  if (context().svc !== svc) throw new Error('账号已切换');
  return {
    id: basename(saved.path),
    path: `ai-image:${basename(saved.path)}`,
    name: basename(path),
  };
}
function processor(): AiImageProcessor {
  const { svc, boot } = context();
  const expectedAccount = getAppContext().account;
  const previous = processors.get(svc);
  if (previous) return previous;
  const check = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (context().svc !== svc || getAppContext().account !== expectedAccount)
      throw new DOMException('账号已切换，已停止读取图片', 'AbortError');
  };
  const descriptionRoot = boot.userConfig.cacheDir('ai-image-descriptions');
  const cache = ocrCacheFor(boot.userConfig.cacheDir('ocr'));
  const locate = async (image: AiImageRef, signal?: AbortSignal, metadataOnly = false) => {
    check(signal);
    if (image.path) {
      const root = resolve(assetRoot()) + sep;
      const path = image.path.startsWith('ai-image:')
        ? aiImageAssetPath(image.path.slice('ai-image:'.length))
        : resolve(image.path);
      if (!path.startsWith(root) || path !== aiImageAssetPath(basename(path)))
        throw new Error('图片素材不属于当前账号');
      if (image.id !== basename(path)) throw new Error('图片标识与素材不一致');
      return {
        path,
        online: undefined,
        key: ocrCacheKey(basename(path)),
        variant: 'original' as const,
      };
    }
    if (image.market) {
      const { pack, hash } = image.market;
      const path = await svc.emoji.getMarketFace(pack, hash);
      check(signal);
      if (!path) throw new Error('现有取图链路未能取回商城表情');
      return { path, online: undefined, key: ocrCacheKey(hash), variant: 'original' as const };
    }
    if (!image.chat) throw new Error('图片缺少消息定位信息');
    const ref = image.chat;
    const row = image.media
      ? null
      : ref.kind === 'group'
        ? await svc.msgs.getGroupMessageById(ref.conv, BigInt(ref.msgId))
        : await svc.msgs.getC2cMessageById(ref.conv, BigInt(ref.msgId));
    check(signal);
    const pic = row?.elements.filter((el) => el.type === 'pic')[ref.index];
    if (!image.media && (!row || !pic || pic.type !== 'pic'))
      throw new Error('消息中未找到这张图片');
    const d: Record<string, unknown> = image.media
      ? {
          ...image.media,
          imgWidth: image.media.width,
          imgHeight: image.media.height,
          subType: image.media.emoji ? 1 : 0,
        }
      : pic!.type === 'pic'
        ? { ...pic!.data }
        : {};
    const sendTime = image.media?.sendTime ?? Number(row!.sendTime);
    const online = {
      peerType: ref.kind,
      fileToken: String(d.fileToken ?? ''),
      width: Number(d.imgWidth ?? 0),
      height: Number(d.imgHeight ?? 0),
      md5: String(d.md5 ?? ''),
    };
    const local = await svc.fileSearch.findFile(
      sendTime,
      String(d.fileName ?? ''),
      Number(d.subType) === 1 ? 'emoji' : 'pic',
    );
    check(signal);
    if (local.source || local.thumb)
      return {
        path: (local.source ?? local.thumb)!,
        online,
        key: ocrCacheKey(online.md5) ?? ocrCacheKey(String(d.fileName ?? '')),
        variant: local.source ? ('original' as const) : ('thumb' as const),
      };
    if (metadataOnly)
      return {
        path: null,
        online,
        key: ocrCacheKey(online.md5) ?? ocrCacheKey(String(d.fileName ?? '')),
        variant: 'unknown' as const,
      };
    const query = new URLSearchParams({
      name: String(d.fileName ?? ''),
      t: String(sendTime),
      token: online.fileToken,
      md5: online.md5,
      orig: String(d.originalUrl ?? ''),
      recv: Number(d.subType) === 1 ? '1' : '0',
    });
    const resolved = await resolveChatImageFile(query, () => check(signal));
    if (!resolved.path) throw new Error('现有取图链路未能取回图片');
    check(signal);
    return {
      ...resolved,
      online,
      key: ocrCacheKey(online.md5) ?? ocrCacheKey(String(d.fileName ?? '')),
    };
  };
  const port = new AiImageProcessor({
    ...imageDescriptionCache(descriptionRoot),
    mode: (feature) =>
      (taskImages.getStore()?.settings ?? boot.userConfig.getSettings()).aiImages[feature],
    vision: (input) => {
      const snapshot = taskImages.getStore();
      const endpoint = snapshot ? snapshot.vision : boot.agentLabConfig.resolveVisionEndpoint();
      return endpoint
        ? { ...endpoint, onUsage: (usage) => svc.agentLab.recordImageUsage(usage, input) }
        : null;
    },
    revision: (feature) => {
      const settings = taskImages.getStore()?.settings ?? boot.userConfig.getSettings();
      const mode = feature ? settings.aiImages[feature] : settings.aiImages;
      if (mode === 'placeholder') return 'placeholder';
      const ref = settings.agentLab.defaultVisionModel;
      const provider = ref ? boot.agentLabConfig.getProvider(ref.providerId) : null;
      const vision =
        mode === 'ocr'
          ? null
          : [
              ref,
              provider?.baseUrl,
              provider?.models.find((model) => model.id === ref?.model),
              createHash('sha256')
                .update(provider?.apiKey ?? '')
                .digest('hex'),
            ];
      return JSON.stringify([
        mode,
        vision,
        settings.ocr,
        Boolean(boot.ocrModels.getModelStatus(settings.modelResources.ocr)?.downloaded),
        Boolean(boot.ocrModels.getModelStatus(settings.modelResources.filter)?.downloaded),
      ]);
    },
    load: async (image, signal) => {
      const file = await locate(image, signal);
      if (!file.path) throw new Error('未能取回图片');
      if ((await stat(file.path)).size > MAX_BYTES) throw new Error('图片超过 32 MiB');
      const bytes = await readFile(file.path);
      if (bytes.length > MAX_BYTES) throw new Error('图片超过 32 MiB');
      await imageMetadata(bytes, 64 * 1024 * 1024);
      check(signal);
      return {
        dataUrl: `data:image/${imageFormat(bytes)};base64,${bytes.toString('base64')}`,
        key: createHash('sha256').update(bytes).digest('hex'),
      };
    },
    ocr: async (image, signal) => {
      let file = await locate(image, signal, true);
      const snapshot = taskImages.getStore();
      const localModel = snapshot ? snapshot.localModel : resolveLocalOcrModel();
      const hit = file.key ? await cache.getText(file.key) : null;
      if (
        hit &&
        (hit.source === 'oidb' ||
          (hit.modelId === localModel?.modelId &&
            (hit.frame.variant !== 'thumb' || file.variant === 'thumb')))
      )
        return {
          text: hit.text,
          notes: [`复用${hit.source === 'oidb' ? 'QQ 在线' : '本地'} OCR 缓存。`],
        };
      if (!file.path) file = await locate(image, signal);
      const filterKey =
        file.variant === 'thumb' && file.path
          ? createHash('sha256')
              .update(await readFile(file.path))
              .digest('hex')
          : file.key;
      const filter = await prefilterAutomaticOcr({
        enabled: (taskImages.getStore()?.settings ?? boot.userConfig.getSettings()).ocr
          .prefilterEnabled,
        path: file.path,
        cache,
        cacheKey: filterKey,
      });
      check(signal);
      if (filter.skip) return { text: '', skipped: true, notes: filter.notes };
      const notes = [...filter.notes];
      if (file.online) {
        try {
          const result = await svc.chatImageOcr.recognize(file.online);
          check(signal);
          const text = result.blocks.map((b) => b.text).join('\n');
          if (file.key)
            await cache.putText(file.key, 'oidb', {
              text,
              blocks: result.blocks,
              frame: { width: result.imageWidth, height: result.imageHeight, variant: 'original' },
            });
          return { text, notes: [...notes, '使用 QQ 在线 OCR。'] };
        } catch (error) {
          check(signal);
          notes.push(`在线 OCR 未成功：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const model = localModel;
      if (!model)
        throw new Error([...notes, localOcrBlocker() ?? '没有可用的本地识别模型'].join('；'));
      if (!file.path) throw new Error('本地图片不可用');
      const result = await runLocalOcr(file.path, model);
      check(signal);
      const text = result.blocks.map((b) => b.text).join('\n');
      if (file.key)
        await cache.putText(file.key, `local:${model.modelId}`, {
          text,
          blocks: result.blocks,
          modelId: model.modelId,
          frame: {
            width: result.imageWidth,
            height: result.imageHeight,
            variant: file.variant ?? 'unknown',
          },
        });
      return { text, notes: [...notes, `使用本地 OCR（${model.modelId}）。`] };
    },
  });
  processors.set(svc, port);
  return port;
}
export const accountImagePort: AiImagePort = {
  prepare: (input) => processor().prepare(input),
  revision: (feature) => processor().revision(feature),
};
export function createAccountImagePort(expectedAccount: object): AiImagePort {
  const current = () => {
    if (getAppContext().account !== expectedAccount)
      throw new DOMException('账号已切换', 'AbortError');
    return processor();
  };
  return {
    prepare: async (input) => {
      const prepared = await current().prepare(input);
      current();
      return prepared;
    },
    revision: (feature) => current().revision(feature),
  };
}
