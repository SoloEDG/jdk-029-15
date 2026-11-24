import type { Take } from '../../../shared/document'

const name = 'night-session'
const table = 'takes'

function connect() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(table, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await connect()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(table, mode)
      const request = operation(transaction.objectStore(table))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

export async function readTakes() {
  const stored = await transact<Take[]>('readonly', store => store.getAll())
  return stored.map(normalizeTake)
}
export const writeTake = (take: Take) => transact('readwrite', store => store.put(take))

/** Older snapshots predate pass metadata; keep them readable. */
function normalizeTake(take: Take): Take {
  return {
    ...take,
    sessionId: take.sessionId ?? take.id,
    pass: take.pass ?? 0,
    onset: take.onset ?? take.start,
    complete: take.complete ?? true,
  }
}
