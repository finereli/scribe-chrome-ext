// Tells Scribe when a call starts and ends on this page, and who it's with.
// The call signal comes from hook.js; the names are read off the page.
//
// Names come from what the page shows, so they can break when Google or
// WhatsApp change their pages. Nothing here ever matches on CSS class
// names, which change all the time.

const APP = location.host === 'meet.google.com' ? 'Google Meet' : 'WhatsApp';
const START_AFTER = 3;   // seconds of call before it counts, so blips don't
const END_AFTER = 4;     // seconds without one before it's over

let live = false;
let active = false;
let streak = 0;
let lastReport = '';
let chatAtStart = null;

window.addEventListener('message', (e) => {
  if (e.source === window && e.data?.__scribe === 'rtc') live = e.data.live;
});

setInterval(() => {
  if (live === active) streak = 0;
  else streak++;
  if (!active && live && streak >= START_AFTER) {
    active = true;
    streak = 0;
    chatAtStart = APP === 'WhatsApp' ? whatsappChat() : null;
  } else if (active && !live && streak >= END_AFTER) {
    active = false;
    streak = 0;
  }
  report();
}, 1000);

function report() {
  const info = active ? who() : {};
  const msg = { type: 'call', active, app: APP, ...info };
  const key = JSON.stringify(msg);
  if (key === lastReport) return;
  lastReport = key;
  console.debug('Scribe:', msg);
  // Throws once the extension reloads; this page needs a refresh then.
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch {}
}

// { title, them, people }: `them` is the one person you're talking to, when
// there is exactly one.
function who() {
  const people = APP === 'Google Meet' ? meetPeople() : [chatAtStart || whatsappChat()].filter(Boolean);
  const them = people.length === 1 ? people[0].split(/\s+/)[0] : null;
  let title = APP === 'Google Meet' ? meetTitle() : null;
  if (!title) {
    if (people.length === 0) title = `${APP} call`;
    else if (people.length <= 2) title = `Call with ${people.join(' and ')}`;
    else title = `Call with ${people[0]}, ${people[1]} and ${people.length - 2} more`;
  }
  return { title, them, people };
}

// --- Google Meet ---

function meetSelf() {
  return document.querySelector('[data-self-name]')?.getAttribute('data-self-name') || null;
}

function meetPeople() {
  const self = meetSelf();
  const names = new Set();
  const add = (n) => {
    n = (n || '').trim();
    if (!n || n === self || /\byou\b/i.test(n) || n.length > 50) return;
    names.add(n);
  };
  // The people panel, when it's open, labels each person.
  document.querySelectorAll('[role="list"][aria-label*="articipant"] [role="listitem"][aria-label]')
    .forEach((el) => add(el.getAttribute('aria-label')));
  // Each video tile carries a participant id and shows the name on it.
  document.querySelectorAll('[data-participant-id]').forEach((tile) => add(tileName(tile)));
  return [...names];
}

// The name is the first short line of plain text on the tile. Icon
// ligatures like "mic_off" and "more_vert" look like snake_case words.
function tileName(tile) {
  const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) {
    const t = node.textContent.trim();
    if (!t || t.length > 40) continue;
    if (/^[a-z_]+$/.test(t) || /[.?!:]$/.test(t) || /^\d/.test(t)) continue;
    return t;
  }
  return null;
}

// A meeting from the calendar has a name; an ad-hoc one only has its code.
function meetTitle() {
  const named = document.querySelector('[data-meeting-title]')?.getAttribute('data-meeting-title');
  if (named && !/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(named)) return named;
  const fromTitle = document.title.replace(/^Meet\s*[-–:]\s*/, '').trim();
  if (fromTitle && fromTitle !== 'Meet' && !/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(fromTitle)) return fromTitle;
  return null;
}

// --- WhatsApp ---

// The open chat's name, from its header. A call is usually started from the
// chat with that person, so it's read when the call starts.
function whatsappChat() {
  const header = document.querySelector('#main header');
  if (!header) return null;
  const el = header.querySelector('span[title]') || header.querySelector('[dir="auto"]');
  return (el?.getAttribute('title') || el?.textContent || '').trim() || null;
}

// For checking the name reader from this content script's console.
window.__scribe = () => ({ app: APP, live, active, ...who() });
