// The engine. Records both sides of the call, cuts them into turns, sends
// each turn to OpenAI and reports the transcript as it grows. It lives in an
// offscreen document because the popup closes whenever you click away.
//
// Offscreen documents only get chrome.runtime, so everything goes through
// messages: the service worker stores the session, the popup draws it.

import { RecognitionQueue } from './lib/queue.js';
import { TurnRecognizer, decibels } from './lib/turns.js';
import { SAMPLE_RATE } from './lib/openai.js';
import { putChunk, saveSession } from './lib/db.js';

let call = null;

const FINISH_PATIENCE = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.target !== 'engine') return;
  if (msg.type === 'start') start(msg).then((r) => reply({ ok: true, ...r }), (e) => reply({ ok: false, error: String(e.message || e) }));
  else if (msg.type === 'stop') stop('stopped');
  else if (msg.type === 'key' && call) call.key = msg.key;
  else if (msg.type === 'names' && call) {
    // Keep a name we already have when the page briefly stops showing it.
    for (const [k, v] of Object.entries(msg.names)) {
      if (v != null && !(Array.isArray(v) && !v.length)) call.session[k] = v;
    }
    push();
  }
  else if (msg.type === 'ping') reply({ recording: !!call });
  return true;
});

function send(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function start({ streamId, session, key, micId }) {
  if (call) throw new Error('Already recording');
  const tab = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });

  // Capturing a tab silences it, so play it back or you'd hear nothing.
  const playback = new AudioContext();
  playback.createMediaStreamSource(tab).connect(playback.destination);

  let mic = null, micError = null;
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: micId ? { ideal: micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    console.warn('Scribe: no microphone:', e);
    micError = `${e.name}: ${e.message}`;
  }

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule('worklet.js');
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);

  call = {
    session: { ...session, turns: [], missingTurns: 0, recording: true, finishing: false, audioType: AUDIO_TYPE },
    key,
    began: performance.now(),
    tab, mic, playback, ctx,
    speakers: {},
    recorders: [],
    levels: { me: 0, them: 0 },
  };

  call.queue = new RecognitionQueue({
    getKey: () => call?.key,
    onTurn: (turn) => upsert(turn),
    onFailed: (turn) => {
      remove(turn.id);
      call.session.missingTurns++;
      push();
    },
    onStatus: (problem) => send({ target: 'sw', type: 'status', problem }),
  });

  for (const [speaker, stream] of [['them', tab], ['me', mic]]) {
    if (!stream) continue;
    const node = new AudioWorkletNode(ctx, 'tap');
    ctx.createMediaStreamSource(stream).connect(node);
    node.connect(sink);
    const s = { offset: null, frames: 0, recognizer: new TurnRecognizer(speaker, call.queue) };
    call.speakers[speaker] = s;
    node.port.onmessage = (e) => chunk(speaker, s, e.data);
    record(speaker, stream);
  }

  // The tab closed or navigated away: the call is over.
  tab.getAudioTracks()[0].addEventListener('ended', () => stop('tab closed'));

  call.meter = setInterval(() => {
    send({ target: 'popup', type: 'levels', ...call.levels });
  }, 66);
  push();
  return { micError };
}

function chunk(speaker, s, samples) {
  if (!call) return;
  if (s.offset === null) {
    s.offset = Math.max(0, (performance.now() - call.began) / 1000 - samples.length / SAMPLE_RATE);
  }
  const t = s.offset + s.frames / SAMPLE_RATE;
  s.frames += samples.length;
  const db = decibels(samples);
  s.recognizer.feed(samples, t, db);
  call.levels[speaker] = Math.max(0, Math.min(1, (db + 60) / 60));
}

// M4A when the browser can write it (Chrome can, some Chromium builds
// can't), else Opus in WebM. Either is about 14 MB an hour per side.
const AUDIO_TYPE = MediaRecorder.isTypeSupported('audio/mp4;codecs=mp4a.40.2')
  ? 'audio/mp4;codecs=mp4a.40.2' : 'audio/webm;codecs=opus';

// Each side as its own compressed file, saved every few seconds.
function record(speaker, stream) {
  const rec = new MediaRecorder(stream, { mimeType: AUDIO_TYPE, audioBitsPerSecond: 32000 });
  let seq = 0;
  const id = call.session.id;
  const writes = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) writes.push(putChunk(id, speaker, seq++, e.data));
  };
  // A recorder stops by itself when its track ends (the tab closed, the mic
  // went away), so listen from the start or that stop goes unheard.
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  rec.start(5000);
  call.recorders.push({ rec, writes, stopped });
}

function upsert(turn) {
  if (!call) return;
  // A blip of noise comes back as no words at all.
  if (turn.isFinal && !turn.text) { remove(turn.id); push(); return; }
  const turns = call.session.turns;
  const i = turns.findIndex((t) => t.id === turn.id);
  if (i >= 0) turns[i] = turn;
  else turns.push(turn);
  push();
}

function remove(id) {
  call.session.turns = call.session.turns.filter((t) => t.id !== id);
}

// Tell the service worker about the session, at most a few times a second.
let pushTimer = null;
function push() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (call) send({ target: 'sw', type: 'session', session: call.session });
  }, 150);
}

async function stop(reason) {
  if (!call || call.stopping) return;
  const c = call;
  c.stopping = true;
  console.log('Scribe: stopping,', reason);
  c.session.duration = (performance.now() - c.began) / 1000;
  c.session.finishing = true;
  c.session.recording = false;
  push();

  for (const s of Object.values(c.speakers)) s.recognizer.finishTurn();
  clearInterval(c.meter);
  send({ target: 'popup', type: 'levels', me: 0, them: 0 });

  const flushed = Promise.all(c.recorders.map(async ({ rec, writes, stopped }) => {
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    await Promise.allSettled(writes);
  }));
  await Promise.race([flushed, sleep(5000)]);
  for (const stream of [c.tab, c.mic]) stream?.getTracks().forEach((t) => t.stop());
  c.ctx.close();
  c.playback.close();

  // Let the last turns come back, but don't wait long on a slow or dead
  // network: a turn still out after this is left out of the transcript.
  const waitStart = performance.now();
  const drained = await Promise.race([c.queue.drain().then(() => true), sleep(FINISH_PATIENCE).then(() => false)]);
  const waited = ((performance.now() - waitStart) / 1000).toFixed(1);
  console.log(drained ? `Scribe: last turns back after ${waited}s` : `Scribe: gave up on the last turns after ${waited}s`, c.queue.stats());
  c.session.finishing = false;
  // Turns still waiting on OpenAI count as missing, so the transcript says so.
  c.session.missingTurns += c.session.turns.filter((t) => !t.isFinal).length;
  c.session.turns = c.session.turns.filter((t) => t.isFinal);
  call = null;
  await saveSession(c.session).catch((e) => console.warn('Scribe: session not saved:', e));
  send({ target: 'sw', type: 'stopped', session: c.session, reason });
}
