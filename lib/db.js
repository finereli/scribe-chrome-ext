// Every call, kept in IndexedDB: each side's audio as compressed chunks,
// written as the call goes so nothing is lost if the browser closes
// mid-call, and the finished session next to it. This is the local copy;
// the archive is meant to be Google Drive.

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('scribe', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function putChunk(sessionId, speaker, seq, blob) {
  const db = await open();
  const tx = db.transaction('chunks', 'readwrite');
  tx.objectStore('chunks').put(blob, [sessionId, speaker, seq]);
  await done(tx);
}

export async function getAudio(sessionId, speaker, type = 'audio/webm') {
  const db = await open();
  const tx = db.transaction('chunks');
  const range = IDBKeyRange.bound([sessionId, speaker, 0], [sessionId, speaker, Infinity]);
  const req = tx.objectStore('chunks').getAll(range);
  await done(tx);
  return req.result.length ? new Blob(req.result, { type: type.split(';')[0] }) : null;
}

export async function saveSession(session) {
  const db = await open();
  const tx = db.transaction('sessions', 'readwrite');
  tx.objectStore('sessions').put(session);
  await done(tx);
}

export async function listSessions() {
  const db = await open();
  const tx = db.transaction('sessions');
  const req = tx.objectStore('sessions').getAll();
  await done(tx);
  return req.result.sort((a, b) => b.createdAt - a.createdAt);
}
