// Every finished call, written as a Markdown file in Downloads/Scribe/, so
// Claude Code or any agent that reads files can find your calls without
// reaching into the browser. The audio stays in the browser.
//
// The file is named after the call's date and title when it's first written.
// storage.local `exports` remembers each call's file name and what was last
// written, so nothing is written twice.

import { duration, sortedTurns, groups, label, isSolo } from './transcript.js';
import { listSessions } from './db.js';

const FOLDER = 'Scribe';

function pad(n) {
  return String(n).padStart(2, '0');
}

// Local time, the way you'd read it: 2026-11-12 16:30.
function localStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ISO with the local offset, so the date in the file matches the clock.
function isoLocal(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${localStamp(ms).replace(' ', 'T')}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function yamlString(s) {
  return JSON.stringify(String(s ?? ''));
}

export function fileName(session) {
  const title = (session.title || 'Call').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${FOLDER}/${localStamp(session.createdAt).replace(':', '')} ${title}.md`;
}

export function markdown(session) {
  const turns = sortedTurns(session).filter((t) => t.text && t.text !== '…' && t.isFinal !== false);
  const people = (session.people || []).filter(Boolean);
  const front = [
    '---',
    `title: ${yamlString(session.title || 'Call')}`,
    `date: ${isoLocal(session.createdAt)}`,
    `duration: ${yamlString(duration(session.duration || 0))}`,
    session.app ? `app: ${yamlString(session.app)}` : null,
    session.them ? `with: ${yamlString(session.them)}` : null,
    people.length ? `people: [${people.map(yamlString).join(', ')}]` : null,
    session.missingTurns ? `missing_turns: ${session.missingTurns}` : null,
    `scribe_id: ${session.id}`,
    '---',
  ].filter((l) => l !== null);

  let body;
  if (!turns.length) {
    body = '_Nothing was transcribed._';
  } else if (isSolo(session)) {
    body = turns.map((t) => t.text).join(' ');
  } else {
    body = groups(turns)
      .map((g) => `**${label(session, g.speaker)}** [${duration(g.start)}]: ${g.turns.map((t) => t.text).join(' ')}`)
      .join('\n\n');
  }
  return `${front.join('\n')}\n\n# ${session.title || 'Call'}\n\n${body}\n`;
}

// Writes the call's file. The name is set the first time and kept, so a
// rename rewrites the title inside the same file instead of leaving a second
// one behind. Quiet: Chrome's download bubble is off while Scribe saves, and
// the download is cleared from Chrome's list once written.
export async function exportSession(session) {
  if (!session?.id || session.recording || session.finishing) return;
  const { exports = {} } = await chrome.storage.local.get('exports');
  const text = markdown(session);
  const before = exports[session.id];
  if (before?.text === text) return;
  const name = before?.name || fileName(session);

  const url = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(text);
  const id = await quietly(() => chrome.downloads.download({ url, filename: name, conflictAction: 'overwrite', saveAs: false }));
  await chrome.downloads.erase({ id }).catch(() => {});

  const fresh = (await chrome.storage.local.get('exports')).exports || {};
  fresh[session.id] = { name, text };
  await chrome.storage.local.set({ exports: fresh });
}

// Writes every saved call that has no file yet, e.g. calls from before this
// existed.
export async function exportAll() {
  const { exports = {} } = await chrome.storage.local.get('exports');
  for (const s of await listSessions()) {
    if (!exports[s.id]) await exportSession(s).catch((e) => console.warn('Scribe: export failed:', e));
  }
}

let quietCount = 0;
async function quietly(fn) {
  quietCount++;
  await chrome.downloads.setUiOptions({ enabled: false }).catch(() => {});
  try {
    const id = await fn();
    await done(id).catch(() => {});
    return id;
  } finally {
    if (--quietCount === 0) await chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
  }
}

function done(id) {
  return new Promise((resolve, reject) => {
    const check = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') { chrome.downloads.onChanged.removeListener(check); resolve(); }
      if (delta.state.current === 'interrupted') { chrome.downloads.onChanged.removeListener(check); reject(new Error('interrupted')); }
    };
    chrome.downloads.onChanged.addListener(check);
    chrome.downloads.search({ id }).then(([d]) => {
      if (d?.state === 'complete') { chrome.downloads.onChanged.removeListener(check); resolve(); }
    });
  });
}
