// The service worker: notices calls, suggests recording them, starts and
// stops the engine, and keeps the session in storage, where the popup reads
// it. It can be shut down at any moment, so everything it knows is in
// storage, never in variables.
//
// storage.local: settings, session (the current or last call), problem
// storage.session: calls (tabs with a call going, by tab id)

import { exportSession, exportAll } from './lib/export.js';
import { saveSession } from './lib/db.js';

const RED = '#e5484d';
const ORANGE = '#f5a524';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Chromium reinstalls an extension given with --load-extension on every
  // launch, so 'install' alone doesn't mean a new user. A saved key does.
  // A saved key once read as missing at launch, so a miss gets a second look
  // before setup opens, and lastInstall keeps what was seen.
  if (reason === 'install') {
    const keyed = async () => !!(await chrome.storage.local.get('settings')).settings?.key;
    const first = await keyed();
    const second = first || (await new Promise((r) => setTimeout(r, 3000)), await keyed());
    await chrome.storage.local.set({ lastInstall: { at: new Date().toISOString(), first, second } });
    if (!second) chrome.tabs.create({ url: 'setup.html' });
  }
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  // A launch with --load-extension comes here, not to onStartup.
  await endOrphan();
  // Calls saved before Scribe wrote files get theirs now.
  exportAll().catch((e) => console.warn('Scribe: export failed:', e));
});

// A browser restart ends any call that was being recorded.
chrome.runtime.onStartup.addListener(async () => {
  await endOrphan();
  exportAll().catch((e) => console.warn('Scribe: export failed:', e));
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'call' && sender.tab) {
    onCall(sender.tab, msg);
    return;
  }
  if (msg.target === 'sw') {
    onEngine(msg);
    return;
  }
  if (msg.target !== 'background') return;
  if (msg.type === 'start') {
    start(msg).then(reply, (e) => reply({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg.type === 'stop') stop();
  if (msg.type === 'rename') rename(msg.title);
  if (msg.type === 'export') exportSession(msg.session).catch((e) => console.warn('Scribe: export failed:', e));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    engine({ type: 'key', key: changes.settings.newValue?.key || null });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { calls = {} } = await chrome.storage.session.get('calls');
  if (calls[tabId]) {
    delete calls[tabId];
    await chrome.storage.session.set({ calls });
  }
});

// --- Calls ---

async function onCall(tab, msg) {
  const { calls = {} } = await chrome.storage.session.get('calls');
  const was = calls[tab.id];
  const { session } = await chrome.storage.local.get('session');
  const recordingHere = session?.recording && session.tabId === tab.id;

  if (msg.active) {
    calls[tab.id] = { app: msg.app, title: msg.title, them: msg.them, people: msg.people, windowId: tab.windowId, since: was?.since || Date.now() };
  } else {
    delete calls[tab.id];
  }
  await chrome.storage.session.set({ calls });

  if (msg.active && !was) {
    if (!recordingHere) {
      chrome.action.setBadgeText({ tabId: tab.id, text: '●' });
      chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: ORANGE });
      chrome.action.setTitle({ tabId: tab.id, title: `Scribe: record this ${msg.app} call` });
      suggest(tab, msg);
    }
  } else if (!msg.active && was) {
    chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    chrome.action.setTitle({ tabId: tab.id, title: 'Scribe' });
    chrome.notifications.clear(`call-${tab.id}`);
    // The call ended, so the recording ends with it.
    if (recordingHere) engine({ type: 'stop' });
  }

  // Names show up on the page a few seconds into the call.
  if (msg.active && recordingHere) {
    const names = { them: msg.them, people: msg.people };
    if (!session.titleEdited) names.title = msg.title;
    engine({ type: 'names', names });
  }
}

async function suggest(tab, msg) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (settings.suggest === false) return;
  chrome.notifications.create(`call-${tab.id}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: msg.title || `${msg.app} call`,
    message: 'Click to record it with Scribe.',
    priority: 1,
  });
}

chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  const tabId = Number(id.replace('call-', ''));
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.action.openPopup({ windowId: tab.windowId });
  } catch (e) {
    console.warn('Scribe: could not open the popup:', e);
  }
});

// --- Recording ---

async function start({ streamId, tabId }) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const { calls = {} } = await chrome.storage.session.get('calls');
  const info = calls[tabId] || {};
  let tabTitle = '';
  try { tabTitle = (await chrome.tabs.get(tabId)).title || ''; } catch {}

  const session = {
    id: crypto.randomUUID(),
    title: info.title || (tabTitle ? `Call in ${tabTitle}` : 'Call'),
    app: info.app || null,
    them: info.them || null,
    people: info.people || [],
    createdAt: Date.now(),
    duration: 0,
    tabId,
  };

  await ensureEngine();
  const res = await engine({ type: 'start', streamId, session, key: settings.key || null, micId: settings.micId || null });
  if (!res?.ok) return { ok: false, error: res?.error || 'The recorder did not start' };

  await chrome.storage.local.set({
    session: { ...session, turns: [], recording: true, finishing: false },
    problem: settings.key ? null : { kind: 'noKey' },
    micDenied: !!res.micError,
  });
  if (res.micError) console.warn('Scribe: recording without the microphone:', res.micError);
  chrome.action.setBadgeText({ tabId, text: '' });
  chrome.action.setBadgeText({ text: 'REC' });
  chrome.action.setBadgeBackgroundColor({ color: RED });
  chrome.notifications.clear(`call-${tabId}`);
  return { ok: true, micError: res.micError || null };
}

// Stop the engine, or, when there's no engine left to stop, end the call it
// left behind.
async function stop() {
  if ((await engine({ type: 'ping' }))?.recording) engine({ type: 'stop' });
  else await endOrphan();
}

// A session that says it's recording with no engine running is a call the
// engine died during (a browser restart, a crash). End it with what it has:
// the finished turns, and the end of the last one as its duration.
async function endOrphan() {
  const { session } = await chrome.storage.local.get('session');
  if (!session?.recording && !session?.finishing) return;
  if ((await engine({ type: 'ping' }))?.recording) return;
  const turns = (session.turns || []).filter((t) => t.isFinal);
  const ended = {
    ...session,
    recording: false,
    finishing: false,
    turns,
    missingTurns: (session.missingTurns || 0) + (session.turns || []).length - turns.length,
    duration: session.duration || Math.max(0, ...turns.map((t) => t.end || 0)),
  };
  await chrome.storage.local.set({ session: ended });
  chrome.action.setBadgeText({ text: '' });
  await saveSession(ended).catch((e) => console.warn('Scribe: session not saved:', e));
  exportSession(ended).catch((e) => console.warn('Scribe: export failed:', e));
}

async function onEngine(msg) {
  if (msg.type === 'session') {
    await chrome.storage.local.set({ session: msg.session });
  } else if (msg.type === 'status') {
    await chrome.storage.local.set({ problem: msg.problem });
  } else if (msg.type === 'stopped') {
    await chrome.storage.local.set({ session: msg.session });
    chrome.action.setBadgeText({ text: '' });
    exportSession(msg.session).catch((e) => console.warn('Scribe: export failed:', e));
    chrome.offscreen.closeDocument().catch(() => {});
  }
}

async function rename(title) {
  const { session } = await chrome.storage.local.get('session');
  if (!session) return;
  if (session.recording || session.finishing) {
    engine({ type: 'names', names: { title, titleEdited: true } });
  } else {
    const renamed = { ...session, title, titleEdited: true };
    await chrome.storage.local.set({ session: renamed });
    exportSession(renamed).catch((e) => console.warn('Scribe: export failed:', e));
  }
}

async function ensureEngine() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Records the call tab and the microphone',
  });
}

async function engine(msg) {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!contexts.length) return null;
  return chrome.runtime.sendMessage({ target: 'engine', ...msg }).catch(() => null);
}
