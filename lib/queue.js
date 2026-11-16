// Transcribes turns with OpenAI, one upload per turn. A port of the Mac
// app's RecognitionQueue.
//
// Turns upload in parallel (a few at a time) and land in any order; each
// carries its own start time, so the transcript sorts itself. No language is
// set: OpenAI works it out per turn.
//
// What can go wrong:
// - No key, or a key OpenAI rejects: fail at once, and keep failing fast
//   until the key changes.
// - Out of credit: fail, and don't try again for a minute.
// - Rate limits and server errors: retry with backoff.
// - Offline: keep retrying for a few minutes, so a dropped connection
//   catches up instead of losing turns.

import { transcribe, encodeWAV, SAMPLE_RATE } from './openai.js';

const MAX_UPLOADS = 6;
const OFFLINE_PATIENCE = 180_000;

export class RecognitionQueue {
  constructor({ getKey, onTurn, onFailed, onStatus }) {
    this.getKey = getKey;
    this.onTurn = onTurn;       // (turn) for every placeholder and result
    this.onFailed = onFailed;   // (turn) that couldn't be transcribed
    this.onStatus = onStatus;   // (problem | null)
    this.open = new Map();
    this.waiting = [];
    this.running = 0;
    this.retrying = 0;
    this.context = '';
    this.cancelled = false;
    this.refused = null;        // { key, problem, until }
    this.drainWaiters = [];
  }

  begin(speaker, start) {
    const job = { id: crypto.randomUUID(), speaker, start, chunks: [], length: 0, attempt: 0, offlineSince: null, prompt: '' };
    this.open.set(job.id, job);
    // Show that this speaker is talking until the text arrives, unless it's
    // already clear no text is coming.
    if (!this.blocker()) this.onTurn({ id: job.id, speaker, start, end: start, text: '…', isFinal: false });
    return job.id;
  }

  append(id, samples) {
    const job = this.open.get(id);
    if (!job) return;
    job.chunks.push(samples);
    job.length += samples.length;
  }

  end(id) {
    const job = this.open.get(id);
    if (!job || this.cancelled) return;
    this.open.delete(id);
    job.prompt = this.context;
    this.waiting.push(job);
    this.pump();
  }

  // Resolves once every turn begun so far is transcribed or has failed.
  drain() {
    return new Promise((resolve) => { this.drainWaiters.push(resolve); this.checkDrained(); });
  }

  stats() {
    return { open: this.open.size, waiting: this.waiting.length, running: this.running, retrying: this.retrying };
  }

    turnOf(job, text, isFinal = true) {
    return { id: job.id, speaker: job.speaker, start: job.start, end: job.start + job.length / SAMPLE_RATE, text, isFinal };
  }

  blocker() {
    const key = this.getKey();
    if (!key) return { kind: 'noKey' };
    const r = this.refused;
    if (r && r.key === key && Date.now() < r.until) return r.problem;
    return null;
  }

  pump() {
    while (this.running < MAX_UPLOADS && this.waiting.length && !this.cancelled) {
      const job = this.waiting.shift();
      const problem = this.blocker();
      if (problem) { this.fail(job, problem); continue; }
      const key = this.getKey();
      this.running++;
      job.attempt++;
      const samples = new Float32Array(job.length);
      let o = 0;
      for (const c of job.chunks) { samples.set(c, o); o += c.length; }
      transcribe(encodeWAV(samples), job.prompt, key).then((outcome) => {
        this.running--;
        this.handle(outcome, job, key);
        this.pump();
      });
    }
    this.checkDrained();
  }

  handle(outcome, job, key) {
    if (this.cancelled) return;
    switch (outcome.kind) {
      case 'text':
        if (outcome.text) this.context = (this.context + ' ' + outcome.text).slice(-200);
        this.refused = null;
        this.onTurn(this.turnOf(job, outcome.text));
        this.onStatus(null);
        break;
      case 'rejected': {
        const problem = { kind: 'rejected', message: outcome.message };
        this.refused = { key, problem, until: Infinity };
        this.fail(job, problem);
        break;
      }
      case 'noCredit': {
        const problem = { kind: 'noCredit' };
        this.refused = { key, problem, until: Date.now() + 60_000 };
        this.fail(job, problem);
        break;
      }
      case 'busy':
        if (job.attempt < 6) this.retry(job, Math.min(30, 2 ** job.attempt) * 1000);
        else this.fail(job, null);
        break;
      case 'offline':
        job.offlineSince ??= Date.now();
        this.onStatus({ kind: 'offline' });
        if (Date.now() - job.offlineSince < OFFLINE_PATIENCE) this.retry(job, 5000);
        else this.fail(job, null);
        break;
      default:
        console.warn('Scribe: turn not transcribed:', outcome.message);
        this.fail(job, null);
    }
  }

  retry(job, delay) {
    this.retrying++;
    setTimeout(() => {
      this.retrying--;
      if (this.cancelled) return this.checkDrained();
      this.waiting.unshift(job);
      this.pump();
    }, delay);
  }

  fail(job, problem) {
    this.onFailed(this.turnOf(job, ''));
    if (problem) this.onStatus(problem);
  }

  checkDrained() {
    const idle = this.running === 0 && this.retrying === 0 && (this.cancelled || (this.open.size === 0 && this.waiting.length === 0));
    if (!idle || !this.drainWaiters.length) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    waiters.forEach((w) => w());
  }
}
