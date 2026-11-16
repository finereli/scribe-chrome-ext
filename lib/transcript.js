// Turning a session's turns into something to read or paste. Shared by the
// popup and the engine.

export function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

// The name for the other side: the one person you're talking to when Scribe
// knows who that is, else "Them".
export function themLabel(session) {
  return session?.them || 'Them';
}

export function label(session, speaker) {
  return speaker === 'me' ? 'Me' : themLabel(session);
}

export function sortedTurns(session) {
  return [...(session?.turns || [])].sort((a, b) => a.start - b.start);
}

// Consecutive turns by the same speaker, shown as one paragraph.
export function groups(turns) {
  const out = [];
  for (const t of turns) {
    if (!t.text) continue;
    const last = out[out.length - 1];
    if (last && last.speaker === t.speaker) last.turns.push(t);
    else out.push({ id: t.id, speaker: t.speaker, start: t.start, turns: [t] });
  }
  return out;
}

// True when only the microphone said anything, e.g. a note said out loud.
export function isSolo(session) {
  return !(session?.turns || []).some((t) => t.speaker === 'them' && t.text && t.isFinal);
}

export function transcriptText(session) {
  const turns = sortedTurns(session).filter((t) => t.text && t.text !== '…');
  if (isSolo(session)) return turns.map((t) => t.text).join(' ');
  return groups(turns)
    .map((g) => `[${duration(g.start)}] ${label(session, g.speaker)}: ${g.turns.map((t) => t.text).join(' ')}`)
    .join('\n\n');
}

// The line that goes in front of a transcript handed to Claude or ChatGPT.
export function assistantPrompt(session) {
  const text = transcriptText(session);
  if (!text) return '';
  if (isSolo(session)) {
    return `Here's something I just said out loud. It was transcribed automatically, so some words may be misheard.\n\n${text}`;
  }
  const them = themLabel(session);
  const who = them === 'Them'
    ? '"Me" is me and "Them" is the other side of the call.'
    : `"Me" is me and "${them}" is the person I was talking to.`;
  const what = session.title ? ` (${session.title})` : '';
  return `Here's the transcript of a call I just had${what}. It was transcribed automatically, so some words may be misheard. ${who}\n\n${text}`;
}

// true for right-to-left, false for left-to-right, null with no letters.
export function direction(text) {
  for (const ch of text) {
    const v = ch.codePointAt(0);
    if ((v >= 0x0590 && v <= 0x08ff) || (v >= 0xfb1d && v <= 0xfdff) || (v >= 0xfe70 && v <= 0xfeff)) return true;
    if ((v >= 0x41 && v <= 0x5a) || (v >= 0x61 && v <= 0x7a) || (v >= 0xc0 && v <= 0x24f) || (v >= 0x370 && v <= 0x4ff)) return false;
  }
  return null;
}

// Splits text after sentence-ending punctuation, keeping it.
export function sentences(text) {
  return text.split(/(?<=[.?!…])\s+/).filter(Boolean);
}
