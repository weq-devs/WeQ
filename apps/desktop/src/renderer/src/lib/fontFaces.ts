export interface FontLease {
  ready: Promise<boolean>;
  release(): void;
}
export const FONT_FACE_LIMIT = 128;

/** 按文档、字体族和资源版本共享；最后一个持有者离开即撤销，迟到加载不注册。 */
function createFontFaces() {
  type Entry = { users: number; face: FontFace; ready: Promise<boolean> };
  const documents = new WeakMap<Document, { entries: Map<string, Entry>; loading: number }>();
  let retained = 0;
  let loading = 0;
  return {
    acquire(family: string, url: string, target = document): FontLease {
      let state = documents.get(target);
      if (!state) {
        state = { entries: new Map(), loading: 0 };
        documents.set(target, state);
      }
      const owner = state;
      const { entries } = owner;
      const key = JSON.stringify([family, url]);
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= FONT_FACE_LIMIT || owner.loading >= FONT_FACE_LIMIT)
          return { ready: Promise.resolve(false), release() {} };
        let face: FontFace;
        try {
          face = new FontFace(family, `url("${url}")`);
        } catch {
          return { ready: Promise.resolve(false), release() {} };
        }
        owner.loading++;
        loading++;
        const created = { users: 0, face, ready: Promise.resolve(false) };
        entries.set(key, created);
        retained++;
        created.ready = new Promise<FontFace>((resolve) => resolve(face.load()))
          .then(() => {
            if (!created.users || entries.get(key) !== created) return false;
            target.fonts.add(face);
            return true;
          })
          .catch(() => false)
          .finally(() => {
            owner.loading--;
            loading--;
          });
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
          }
        },
      };
    },
    count: () => retained,
    loading: () => loading,
  };
}

export const fontFaces = createFontFaces();
