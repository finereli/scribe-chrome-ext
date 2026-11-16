// The popup draws whatever is in storage (the session, the problem, the
// call on this tab) and redraws when it changes. The engine keeps running
// when the popup closes, so this is only a view and a few buttons.

import { duration, groups, sortedTurns, label, themLabel, transcriptText, assistantPrompt, direction, sentences } from './lib/transcript.js';
import { checkKey, maskKey, BILLING_URL } from './lib/openai.js';
import { getAudio, listSessions, saveSession } from './lib/db.js';

const $ = (id) => document.getElementById(id);
const SEGMENTS = 20;

let state = { session: null, problem: null, micDenied: false, settings: {}, calls: {}, micAllowed: true };
let tab = null;
// A past call opened from the list. The popup shows it in place of the current one.
let viewing = null;
let shownNow = null;

// --- Load and listen ---

async function load() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const local = await chrome.storage.local.get(['session', 'problem', 'micDenied', 'settings']);
  const { calls = {} } = await chrome.storage.session.get('calls');
  state = { ...state, ...local, settings: local.settings || {}, calls };
  render();
  try {
    const perm = await navigator.permissions.query({ name: 'microphone' });
    state.micAllowed = perm.state === 'granted';
    perm.onchange = () => { state.micAllowed = perm.state === 'granted'; render(); };
    render();
  } catch {}
}

const allowMic = () => chrome.tabs.create({ url: 'setup.html#step-mic' });

chrome.storage.onChanged.addListener((changes, area) => {
  for (const [k, { newValue }] of Object.entries(changes)) {
    if (area === 'local' && k in state) state[k] = newValue ?? (k === 'settings' ? {} : null);
    if (area === 'session' && k === 'calls') state.calls = newValue || {};
  }
  render();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target === 'popup' && msg.type === 'levels') {
    meter('me', msg.me);
    meter('them', msg.them);
  }
});

// --- Drawing ---

const recording = () => !!state.session?.recording;
const finishing = () => !!state.session?.finishing;
const callHere = () => (tab && state.calls[tab.id]) || null;

function render() {
  const s = state.session;
  const showSession = s && (recording() || finishing() || !callHere() || s.tabId === tab?.id);
  const shown = viewing || (showSession ? s : null);
  shownNow = shown;
  $('viewing').hidden = !viewing;
  if (viewing) $('viewing-text').textContent = recording() ? 'A past call. Still recording the current one.' : 'A past call';

  // Header
  const title = $('title');
  if (document.activeElement !== title) title.value = shown?.title || callHere()?.title || 'Scribe';
  title.disabled = !shown;
  $('app').textContent = shown?.app || callHere()?.app || '';
  clock();

  const hasText = !!(shown && transcriptText(shown));
  for (const id of ['claude', 'chatgpt', 'copy']) $(id).disabled = !hasText;
  $('download').disabled = !shown || (!viewing && (recording() || finishing()));

  // Footer
  const rec = $('rec');
  rec.classList.toggle('on', recording());
  rec.disabled = finishing();
  rec.title = recording() ? 'Stop recording' : 'Record the call in this tab';
  $('them-label').textContent = shown ? themLabel(shown) : (callHere()?.them || 'Them');
  if (!recording()) { meter('me', 0); meter('them', 0); }

  banner();
  transcript(shown);
}

function clock() {
  const s = viewing || state.session;
  const el = $('clock');
  if (viewing) {
    el.className = '';
    el.textContent = `${new Date(s.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${duration(s.duration)}`;
  } else if (recording()) {
    el.className = 'live';
    el.textContent = duration((Date.now() - s.createdAt) / 1000);
  } else if (finishing()) {
    el.className = '';
    el.textContent = 'Finishing the last words…';
  } else if (s && $('title').disabled === false) {
    el.className = '';
    el.textContent = `${new Date(s.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${duration(s.duration)}`;
  } else {
    el.className = '';
    el.textContent = '';
  }
}
setInterval(() => recording() && !viewing && clock(), 1000);

function meter(who, level) {
  const el = $(`meter-${who}`);
  if (!el.children.length) el.innerHTML = '<i></i>'.repeat(SEGMENTS);
  const lit = Math.round(level * SEGMENTS);
  [...el.children].forEach((seg, i) => {
    const f = i / SEGMENTS;
    seg.className = i < lit ? (f > 0.85 ? 'r' : f > 0.65 ? 'y' : 'g') : '';
  });
}

function transcript(session) {
  const main = $('transcript');
  if (!session) {
    const call = callHere();
    main.innerHTML = call
      ? `<div class="empty">${waveIcon}<div class="call"></div><div>Press the red button to transcribe it.</div></div>`
      : `<div class="empty">${waveIcon}<div>Press the red button when the call starts.</div><small>Scribe records the tab you're in and your microphone.</small></div>`;
    if (call) main.querySelector('.call').textContent = call.title || `${call.app} call`;
    return;
  }

  const gs = groups(sortedTurns(session));
  if (!gs.length) {
    const text = recording() ? 'Listening…' : finishing() ? '' : 'Nothing was transcribed.';
    main.innerHTML = `<div class="empty"><div></div></div>`;
    main.querySelector('.empty div').textContent = text;
    return;
  }

  const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 60;
  main.replaceChildren(...gs.map((g) => groupEl(session, g)));
  if (session.missingTurns && !recording() && !finishing()) {
    const note = document.createElement('div');
    note.className = 'empty';
    note.style.height = 'auto';
    note.innerHTML = '<small></small>';
    note.firstChild.textContent = session.missingTurns === 1
      ? 'One part of this call wasn\'t transcribed.'
      : `${session.missingTurns} parts of this call weren't transcribed.`;
    main.append(note);
  }
  if (nearBottom || (recording() && !viewing)) main.scrollTop = main.scrollHeight;
}

function groupEl(session, g) {
  const el = document.createElement('div');
  el.className = `group ${g.speaker}`;
  const who = document.createElement('div');
  who.className = 'who';
  const name = document.createElement('b');
  name.textContent = label(session, g.speaker);
  const time = document.createElement('time');
  time.textContent = duration(g.start);
  who.append(name, time);

  // A speaker who moves between Hebrew and English gets a new paragraph at
  // each switch, so each reads in its own direction.
  const text = document.createElement('div');
  text.className = 'text';
  let p = null, rtl = null;
  for (const turn of g.turns) {
    for (const sentence of sentences(turn.text)) {
      const d = direction(sentence) ?? rtl ?? false;
      if (!p || d !== rtl) {
        p = document.createElement('p');
        p.dir = d ? 'rtl' : 'ltr';
        text.append(p);
        rtl = d;
      }
      const span = document.createElement('span');
      span.textContent = (p.childNodes.length ? ' ' : '') + sentence;
      if (!turn.isFinal) span.className = 'pending';
      p.append(span);
    }
  }
  el.append(who, text);
  return el;
}

function banner() {
  const el = $('banner');
  const problem = state.problem;
  const note = recording() ? ' The call is still being recorded.' : '';
  let b = null;
  if (!state.settings.key) {
    b = { tint: 'var(--yellow)', title: 'Add your OpenAI key to transcribe calls', text: 'Scribe uses your own OpenAI account to write down what\'s said.' + note, button: 'Add Key…', action: openSettings };
  } else if (!state.micAllowed) {
    b = { tint: 'var(--yellow)', title: 'Scribe can\'t use your microphone yet', text: recording() ? 'Only the other side is being recorded. Allow the microphone, then start a new recording.' : 'Allow it once, or only the other side gets recorded.', button: 'Allow…', action: allowMic };
  } else if (recording() && state.micDenied) {
    b = { tint: 'var(--yellow)', title: 'Scribe can\'t hear your microphone', text: 'Only the other side is being recorded. Check that a microphone is connected and that your system lets the browser use it.' };
  } else if (problem?.kind === 'rejected') {
    b = { tint: 'var(--red)', title: 'OpenAI rejected your API key', text: problem.message + note, button: 'Fix Key…', action: openSettings };
  } else if (problem?.kind === 'noCredit') {
    b = { tint: 'var(--them)', title: 'Your OpenAI account is out of credit', text: 'Add credit to keep transcribing.' + note, button: 'Add Credit', action: () => chrome.tabs.create({ url: BILLING_URL }) };
  } else if (problem?.kind === 'offline' && recording()) {
    b = { tint: 'var(--yellow)', title: 'Can\'t reach OpenAI', text: 'Transcription will catch up when the connection is back.' };
  }
  el.hidden = !b;
  if (!b) return;
  el.style.setProperty('--tint', b.tint);
  el.innerHTML = '<div><b></b><p></p></div>';
  el.querySelector('b').textContent = b.title;
  el.querySelector('p').textContent = b.text;
  if (b.button) {
    const button = document.createElement('button');
    button.className = 'button';
    button.textContent = b.button;
    button.onclick = b.action;
    el.append(button);
  }
}

const waveIcon = '<svg viewBox="0 0 24 24"><path d="M3 12h1M7 8v8M11 5v14M15 9v6M19 11v2M21 12h0"/></svg>';

// --- Actions ---

$('rec').onclick = async () => {
  if (recording()) {
    chrome.runtime.sendMessage({ target: 'background', type: 'stop' });
    return;
  }
  if (!tab) return;
  viewing = null;
  $('rec').disabled = true;
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await chrome.runtime.sendMessage({ target: 'background', type: 'start', streamId, tabId: tab.id });
    if (!res?.ok) toast(res?.error || 'Couldn\'t start recording', 3500);
  } catch (e) {
    console.warn('Scribe: start failed:', e);
    toast(/invoked|activeTab|permission/i.test(e.message) ? 'Click the Scribe icon in the toolbar, then record' : String(e.message || e), 4000);
  } finally {
    $('rec').disabled = false;
    render();
  }
};

$('title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur();
  if (e.key === 'Escape') { e.target.value = shownNow?.title || ''; e.target.blur(); }
});
$('title').addEventListener('change', async (e) => {
  const title = e.target.value.trim();
  if (!title || title === shownNow?.title) return;
  if (viewing) {
    viewing = { ...viewing, title, titleEdited: true };
    await saveSession(viewing);
    chrome.runtime.sendMessage({ target: 'background', type: 'export', session: viewing });
    if (viewing.id !== state.session?.id) return render();
  }
  chrome.runtime.sendMessage({ target: 'background', type: 'rename', title });
  // A finished call is also in the list of past calls, so rename it there.
  if (!viewing && state.session && !recording() && !finishing()) {
    saveSession({ ...state.session, title, titleEdited: true }).catch(() => {});
  }
});

$('copy').onclick = async () => {
  await navigator.clipboard.writeText(transcriptText(shownNow));
  toast('Transcript copied');
};

for (const [id, url, name] of [['claude', 'https://claude.ai/new', 'Claude'], ['chatgpt', 'https://chatgpt.com/', 'ChatGPT']]) {
  $(id).onclick = async () => {
    await navigator.clipboard.writeText(assistantPrompt(shownNow));
    toast(`Copied. Paste it into ${name}`);
    setTimeout(() => chrome.tabs.create({ url }), 500);
  };
}

$('download').onclick = async () => {
  const s = shownNow;
  const stamp = new Date(s.createdAt).toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
  const base = `${stamp} ${s.title}`.replace(/[\\/:*?"<>|]/g, '-');
  const ext = s.audioType?.startsWith('audio/mp4') ? 'm4a' : 'webm';
  const files = [[new Blob([transcriptText(s)], { type: 'text/plain' }), `${base}.txt`]];
  for (const speaker of ['me', 'them']) {
    const blob = await getAudio(s.id, speaker, s.audioType);
    if (blob) files.push([blob, `${base} - ${speaker === 'me' ? 'Me' : themLabel(s)}.${ext}`]);
  }
  for (const [blob, name] of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    await new Promise((r) => setTimeout(r, 300));
  }
};

// --- Settings ---

async function openSettings() {
  $('settings').hidden = false;
  const key = state.settings.key;
  $('key').value = '';
  $('key').placeholder = key ? 'Paste a new key' : 'sk-…';
  showKey(!!key);
  $('suggest').checked = state.settings.suggest !== false;
  const select = $('mic');
  select.replaceChildren(new Option('Same as system', ''));
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
    for (const d of devices) select.append(new Option(d.label || 'Microphone', d.deviceId));
  } catch {}
  select.value = state.settings.micId || '';
}

// With a key saved, show that and hide the field until you ask to change it.
function showKey(saved) {
  $('key-saved').hidden = !saved;
  $('key-row').hidden = saved;
  if (saved) $('key-saved-text').textContent = `${maskKey(state.settings.key)} is saved.`;
}

$('change-key').onclick = (e) => {
  e.preventDefault();
  showKey(false);
  $('key').focus();
};

function saveSettings(patch) {
  return chrome.storage.local.set({ settings: { ...state.settings, ...patch } });
}

$('gear').onclick = openSettings;
$('close-settings').onclick = () => { $('settings').hidden = true; };
$('mic').onchange = (e) => saveSettings({ micId: e.target.value || null });
$('suggest').onchange = (e) => saveSettings({ suggest: e.target.checked });
$('shortcuts').onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); };

$('save-key').onclick = async () => {
  const key = $('key').value.trim();
  const status = $('key-status');
  if (!key) return;
  status.className = '';
  status.textContent = 'Checking the key with OpenAI…';
  const outcome = await checkKey(key);
  if (outcome.kind === 'text' || outcome.kind === 'busy') {
    await saveSettings({ key });
    await chrome.storage.local.set({ problem: null });
    status.className = 'ok';
    status.textContent = 'OpenAI accepted it.';
    $('key').value = '';
    showKey(true);
  } else if (outcome.kind === 'noCredit') {
    await saveSettings({ key });
    status.className = 'bad';
    status.textContent = 'Saved, but this OpenAI account is out of credit.';
    $('key').value = '';
    showKey(true);
  } else {
    status.className = 'bad';
    status.textContent = outcome.message || 'Couldn\'t reach OpenAI to check the key.';
  }
};

// --- Past calls ---

async function openPast() {
  $('past').hidden = false;
  const list = $('past-list');
  let sessions = [];
  try { sessions = await listSessions(); } catch (e) { console.warn('Scribe: could not list calls:', e); }
  if (!sessions.length) {
    list.innerHTML = '<div class="past-empty">No finished calls yet.</div>';
    return;
  }
  list.replaceChildren(...sessions.map((s) => {
    const item = document.createElement('button');
    item.className = 'past-item';
    const title = document.createElement('b');
    title.textContent = s.title || 'Call';
    const when = document.createElement('small');
    when.textContent = [
      new Date(s.createdAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
      duration(s.duration),
      s.app,
    ].filter(Boolean).join(' · ');
    const first = document.createElement('p');
    first.textContent = sortedTurns(s)[0]?.text || 'Nothing was transcribed.';
    item.append(title, when, first);
    item.onclick = () => {
      viewing = s;
      $('past').hidden = true;
      render();
      $('transcript').scrollTop = 0;
    };
    return item;
  }));
}

$('history').onclick = openPast;
$('close-past').onclick = () => { $('past').hidden = true; };
$('back').onclick = () => { viewing = null; render(); };

// --- Toast ---

let toastTimer;
function toast(text, ms = 1800) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

load();
