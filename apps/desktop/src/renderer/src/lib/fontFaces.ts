export interface FontLease {
  ready: Promise<boolean>;
  release(): void;
}
export const FONT_FACE_LIMIT = 128;
export const FONT_FACE_IDLE_LIMIT = 8;

/** 注册随持有者释放；少量已解码字体按 LRU 保留，滚动返回可同步重新注册。 */
function createFontFaces() {
  type Entry = { users: number; face: FontFace; ready: Promise<boolean>; loaded: boolean };
  const documents = new WeakMap<
    Document,
    { entries: Map<string, Entry>; idle: Map<string, FontFace>; loading: number }
  >();
  let retained = 0;
  let loading = 0;
  return {
    acquire(family: string, url: string, target = document): FontLease {
      let state = documents.get(target);
      if (!state) {
        state = { entries: new Map(), idle: new Map(), loading: 0 };
        documents.set(target, state);
      }
      const owner = state;
      const { entries } = owner;
      const key = JSON.stringify([family, url]);
      let entry = entries.get(key);
      if (!entry) {
        const cached = owner.idle.get(key);
        if (entries.size >= FONT_FACE_LIMIT || (!cached && owner.loading >= FONT_FACE_LIMIT))
          return { ready: Promise.resolve(false), release() {} };
        let face: FontFace;
        try {
          face = cached ?? new FontFace(family, `url("${url}")`);
          if (cached) target.fonts.add(cached);
        } catch {
          return { ready: Promise.resolve(false), release() {} };
        }
        owner.idle.delete(key);
        const created = {
          users: 0,
          face,
          ready: Promise.resolve(Boolean(cached)),
          loaded: Boolean(cached),
        };
        entries.set(key, created);
        retained++;
        if (!cached) {
          owner.loading++;
          loading++;
          created.ready = new Promise<FontFace>((resolve) => resolve(face.load()))
            .then(() => {
              if (!created.users || entries.get(key) !== created) return false;
              target.fonts.add(face);
              created.loaded = true;
              return true;
            })
            .catch(() => false)
            .finally(() => {
              owner.loading--;
              loading--;
            });
        }
        entry = created;
      }
      const held = entry;
      held.users++;
      let released = false;
      return {
        ready: held.ready,
        release() {
          if (released) return;
          released = true;
          if (--held.users) return;
          target.fonts.delete(held.face);
          if (entries.get(key) === held) {
            entries.delete(key);
            retained--;
            if (held.loaded) {
              owner.idle.set(key, held.face);
              while (owner.idle.size > FONT_FACE_IDLE_LIMIT) {
                const oldest = owner.idle.keys().next().value;
                if (oldest !== undefined) owner.idle.delete(oldest);
              }
            }
          }
        },
      };
    },
    isLoaded(family: string, url: string, target = document): boolean {
      const state = documents.get(target);
      const key = JSON.stringify([family, url]);
      return Boolean(
        state?.entries.get(key)?.loaded ||
          (state && state.entries.size < FONT_FACE_LIMIT && state.idle.has(key)),
      );
    },
    clearIdle(target = document) {
      documents.get(target)?.idle.clear();
    },
    count: () => retained,
    loading: () => loading,
  };
}

export const fontFaces = createFontFaces();
