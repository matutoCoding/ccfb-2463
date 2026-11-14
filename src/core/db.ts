// IndexedDB 持久化：藏品元信息、八叉树节点元信息与节点二进制 blob、
// 测量记录、视角书签、应用设置。节点数据以 Blob 存储，避免结构化克隆大数组的开销。
import type {
  Bookmark,
  CollectionRecord,
  MeasureRecord,
  OctreeNodeMeta,
  ViewerSettings,
} from './types';
import { DEFAULT_SETTINGS } from './types';

const DB_NAME = 'stele-pointcloud';
const DB_VERSION = 1;
const STORES = {
  collections: 'collections',
  nodeMeta: 'nodeMeta', // keyPath: [collectionId+':'+id] 复合字符串
  nodeData: 'nodeData',
  measures: 'measures',
  bookmarks: 'bookmarks',
  kv: 'kv',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.collections)) {
        db.createObjectStore(STORES.collections, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.nodeMeta)) {
        db.createObjectStore(STORES.nodeMeta, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.nodeData)) {
        db.createObjectStore(STORES.nodeData); // 复合主键直接用字符串
      }
      if (!db.objectStoreNames.contains(STORES.measures)) {
        const s = db.createObjectStore(STORES.measures, { keyPath: 'id' });
        s.createIndex('byCollection', 'collectionId');
      }
      if (!db.objectStoreNames.contains(STORES.bookmarks)) {
        const s = db.createObjectStore(STORES.bookmarks, { keyPath: 'id' });
        s.createIndex('byCollection', 'collectionId');
      }
      if (!db.objectStoreNames.contains(STORES.kv)) {
        db.createObjectStore(STORES.kv);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | IDBRequest<T>[],
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const req = fn(s);
        t.oncomplete = () => resolve((req as IDBRequest<T>).result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export function nodeKey(collectionId: string, nodeId: number): string {
  return `${collectionId}:${nodeId}`;
}

interface StoredNodeMeta extends Omit<OctreeNodeMeta, 'children'> {
  key: string;
  children: number[]; // IDB 不能直接存 TypedArray 的索引语义，转普通数组
  hasNormals: boolean;
  hasColors: boolean;
}

export const db = {
  // ---------- 藏品 ----------
  listCollections(): Promise<CollectionRecord[]> {
    return tx(STORES.collections, 'readonly', (s) => s.getAll() as IDBRequest<CollectionRecord[]>);
  },
  getCollection(id: string): Promise<CollectionRecord | undefined> {
    return tx(STORES.collections, 'readonly', (s) => s.get(id));
  },
  putCollection(rec: CollectionRecord): Promise<unknown> {
    return tx(STORES.collections, 'readwrite', (s) => s.put(rec));
  },
  async deleteCollection(id: string): Promise<void> {
    const database = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction(
        [STORES.collections, STORES.nodeMeta, STORES.nodeData, STORES.measures, STORES.bookmarks],
        'readwrite',
      );
      t.objectStore(STORES.collections).delete(id);
      const metaStore = t.objectStore(STORES.nodeMeta);
      const dataStore = t.objectStore(STORES.nodeData);
      const range = IDBKeyRange.bound(`${id}:`, `${id}:￿`);
      metaStore.delete(range);
      dataStore.delete(range);
      const mIndex = t.objectStore(STORES.measures).index('byCollection');
      mIndex.openCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
        const cur = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cur) {
          cur.delete();
          cur.continue();
        }
      };
      const bIndex = t.objectStore(STORES.bookmarks).index('byCollection');
      bIndex.openCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
        const cur = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cur) {
          cur.delete();
          cur.continue();
        }
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },

  // ---------- 八叉树节点 ----------
  async putNodes(
    collectionId: string,
    metas: OctreeNodeMeta[],
    blobs: { id: number; blob: Blob }[],
    hasNormals: boolean,
    hasColors: boolean,
  ): Promise<void> {
    const database = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction([STORES.nodeMeta, STORES.nodeData], 'readwrite');
      const metaStore = t.objectStore(STORES.nodeMeta);
      const dataStore = t.objectStore(STORES.nodeData);
      for (const m of metas) {
        const stored: StoredNodeMeta = {
          ...m,
          key: nodeKey(collectionId, m.id),
          children: Array.from(m.children),
          hasNormals,
          hasColors,
        };
        metaStore.put(stored);
      }
      for (const b of blobs) {
        dataStore.put(b.blob, nodeKey(collectionId, b.id));
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },

  async getAllNodeMeta(collectionId: string): Promise<StoredNodeMeta[]> {
    const database = await openDb();
    return new Promise((resolve, reject) => {
      const t = database.transaction(STORES.nodeMeta, 'readonly');
      const range = IDBKeyRange.bound(`${collectionId}:`, `${collectionId}:￿`);
      const req = t.objectStore(STORES.nodeMeta).getAll(range);
      req.onsuccess = () => resolve(req.result as StoredNodeMeta[]);
      req.onerror = () => reject(req.error);
    });
  },

  async getNodeBlob(collectionId: string, nodeId: number): Promise<ArrayBuffer> {
    const blob = await tx(
      STORES.nodeData,
      'readonly',
      (s) => s.get(nodeKey(collectionId, nodeId)) as IDBRequest<Blob | undefined>,
    );
    if (!blob) throw new Error(`节点数据缺失: ${nodeId}`);
    return blob.arrayBuffer();
  },

  // ---------- 测量 ----------
  listMeasures(collectionId?: string): Promise<MeasureRecord[]> {
    return openDb().then(
      (database) =>
        new Promise((resolve, reject) => {
          const t = database.transaction(STORES.measures, 'readonly');
          const s = t.objectStore(STORES.measures);
          const req = collectionId
            ? s.index('byCollection').getAll(collectionId)
            : s.getAll();
          req.onsuccess = () => resolve(req.result as MeasureRecord[]);
          req.onerror = () => reject(req.error);
        }),
    );
  },
  putMeasure(rec: MeasureRecord): Promise<unknown> {
    return tx(STORES.measures, 'readwrite', (s) => s.put(rec));
  },
  deleteMeasure(id: string): Promise<unknown> {
    return tx(STORES.measures, 'readwrite', (s) => s.delete(id));
  },

  // ---------- 书签 ----------
  listBookmarks(collectionId: string): Promise<Bookmark[]> {
    return openDb().then(
      (database) =>
        new Promise((resolve, reject) => {
          const t = database.transaction(STORES.bookmarks, 'readonly');
          const req = t
            .objectStore(STORES.bookmarks)
            .index('byCollection')
            .getAll(collectionId);
          req.onsuccess = () => resolve(req.result as Bookmark[]);
          req.onerror = () => reject(req.error);
        }),
    );
  },
  putBookmark(rec: Bookmark): Promise<unknown> {
    return tx(STORES.bookmarks, 'readwrite', (s) => s.put(rec));
  },
  deleteBookmark(id: string): Promise<unknown> {
    return tx(STORES.bookmarks, 'readwrite', (s) => s.delete(id));
  },

  // ---------- KV 设置 ----------
  async loadSettings(): Promise<ViewerSettings> {
    try {
      const v = await tx(STORES.kv, 'readonly', (s) =>
        s.get('settings'),
      ) as ViewerSettings | undefined;
      return v ? { ...DEFAULT_SETTINGS, ...v } : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },
  saveSettings(settings: ViewerSettings): Promise<unknown> {
    return tx(STORES.kv, 'readwrite', (s) => s.put(settings, 'settings'));
  },
};

export type { StoredNodeMeta };
