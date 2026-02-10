type _AnyRecord = Record<string, any>

const DB_NAME = 'ah32_chat_db_v1'
const DB_VERSION = 1
const STORE_SESSIONS = 'sessions'

let _dbPromise: Promise<IDBDatabase> | null = null

const _report = (scope: string, error: any, level: 'warning' | 'error' = 'warning') => {
  try {
    const fn = (globalThis as any).__ah32_reportError as undefined | ((s: string, e: any, lv?: string) => void)
    if (typeof fn === 'function') {
      fn(`ah32-ui-next/src/services/chat-session-store.ts:${scope}`, error, level)
      return
    }
  } catch { /* ignore */ }
  try {
    console.warn(`[chat-session-store:${scope}]`, error)
  } catch { /* ignore */ }
}

const _openDb = (): Promise<IDBDatabase> => {
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise((resolve, reject) => {
    try {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('indexedDB is not available'))
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          db.createObjectStore(STORE_SESSIONS, { keyPath: 'sessionId' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error || new Error('indexedDB.open failed'))
    } catch (e: any) {
      reject(e)
    }
  })
  _dbPromise.catch((e) => {
    _report('open', e, 'warning')
    _dbPromise = null
  })
  return _dbPromise
}

const _tx = async <T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (os: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const db = await _openDb()
  return await new Promise<T>((resolve, reject) => {
    try {
      const tx = db.transaction(store, mode)
      const os = tx.objectStore(store)
      const req = fn(os)
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error || new Error('indexedDB request failed'))
      tx.onabort = () => reject(tx.error || new Error('indexedDB tx aborted'))
    } catch (e: any) {
      reject(e)
    }
  })
}

export const chatSessionStore = {
  isAvailable(): boolean {
    try {
      return typeof indexedDB !== 'undefined'
    } catch {
      return false
    }
  },

  async getSession<T extends _AnyRecord = _AnyRecord>(sessionId: string): Promise<T | null> {
    const sid = String(sessionId || '').trim()
    if (!sid) return null
    try {
      const row = await _tx<any>(STORE_SESSIONS, 'readonly', (os) => os.get(sid))
      return row && typeof row === 'object' ? (row as T) : null
    } catch (e: any) {
      _report('getSession', e, 'warning')
      return null
    }
  },

  async setSession(session: _AnyRecord): Promise<void> {
    const sid = String((session as any)?.sessionId || '').trim()
    if (!sid) return
    await _tx<any>(STORE_SESSIONS, 'readwrite', (os) => os.put({ ...(session || {}), sessionId: sid }))
  },

  async deleteSession(sessionId: string): Promise<void> {
    const sid = String(sessionId || '').trim()
    if (!sid) return
    await _tx<any>(STORE_SESSIONS, 'readwrite', (os) => os.delete(sid))
  }
}
