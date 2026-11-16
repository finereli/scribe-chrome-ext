// One call to OpenAI's transcription endpoint, with the answer sorted into
// what the caller should do about it. Same model and rules as the Mac app.

export const MODEL = 'gpt-transcribe';
export const BILLING_URL = 'https://platform.openai.com/settings/organization/billing';
export const KEYS_URL = 'https://platform.openai.com/api-keys';
export const SAMPLE_RATE = 16000;

// 16 kHz mono 16-bit: 32 KB a second, so a 30-second turn is about 1 MB.
export function encodeWAV(samples) {
  const bytes = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, bytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}

// Outcome kinds: text, rejected (bad key), noCredit, busy (retry), offline
// (retry longer), failed (give up on this turn).
export async function transcribe(wav, prompt, key) {
  const form = new FormData();
  form.append('model', MODEL);
  form.append('response_format', 'text');
  if (prompt) form.append('prompt', prompt);
  form.append('file', wav, 'turn.wav');

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { kind: 'offline', message: String(e.message || e) };
  }
  const body = await res.text();
  if (res.ok) return { kind: 'text', text: body.trim() };

  let message = body.slice(0, 200), code = null;
  try { const j = JSON.parse(body); message = j.error.message; code = j.error.code; } catch {}
  const s = res.status;
  if (s === 401) return { kind: 'rejected', message: "OpenAI didn't accept this key. It may have been mistyped, deleted or revoked." };
  if (s === 403) return { kind: 'rejected', message: `This key isn't allowed to transcribe audio. ${message}` };
  // Out of credit comes as a 429, like a rate limit, told apart by its code.
  if (s === 429 && code === 'insufficient_quota') return { kind: 'noCredit' };
  if (s === 429 || s >= 500) return { kind: 'busy', message: `${s} ${message}` };
  return { kind: 'failed', message: `${s} ${message}` };
}

// Checks a key by transcribing half a second of silence, which costs a tiny
// fraction of a cent. A key restricted to audio can't list models, so that
// free check would make a good key look broken.
export function checkKey(key) {
  return transcribe(encodeWAV(new Float32Array(8000)), '', key);
}

export function maskKey(key) {
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
