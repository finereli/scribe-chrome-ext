// Cuts one speaker's audio into turns and hands them to the recognition
// queue. A port of the Mac app's TurnRecognizer.
//
// A turn opens when this speaker starts talking and closes after a pause.
// Each turn is one upload, so turns stay short: the text shows up a second
// or two after the turn ends, and a long monologue still arrives in pieces.

import { SAMPLE_RATE } from './openai.js';

const PAUSE_TO_END = 1.0;
const SOFT_LIMIT = 15;
const HARD_LIMIT = 30;
const PREROLL = 0.4;

export function decibels(samples) {
  if (!samples.length) return -100;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return 20 * Math.log10(Math.max(Math.sqrt(sum / samples.length), 1e-7));
}

export class TurnRecognizer {
  constructor(speaker, queue) {
    this.speaker = speaker;
    this.queue = queue;
    this.turn = null;
    this.turnStart = 0;
    this.lastVoice = 0;
    this.preroll = [];
    this.floorDB = -60;
  }

  // Feed one 16 kHz chunk that starts `t` seconds into the call.
  feed(samples, t, db) {
    const length = samples.length / SAMPLE_RATE;
    const end = t + length;

    // Track the noise floor: drop to quiet instantly, rise slowly, so a noisy
    // room doesn't count as speech and a quiet one stays sensitive.
    this.floorDB = db < this.floorDB ? db : Math.min(this.floorDB + length * 0.5, -30);
    const voiced = db > Math.max(this.floorDB + 10, -55);

    if (!this.turn) {
      this.preroll.push({ samples, at: t });
      while (this.preroll.length && end - this.preroll[0].at > PREROLL) this.preroll.shift();
      if (!voiced) return;
      this.turnStart = this.preroll[0]?.at ?? t;
      this.turn = this.queue.begin(this.speaker, this.turnStart);
      for (const p of this.preroll) this.queue.append(this.turn, p.samples);
      this.preroll = [];
      this.lastVoice = end;
      return;
    }

    this.queue.append(this.turn, samples);
    if (voiced) this.lastVoice = end;
    const silence = end - this.lastVoice;
    const elapsed = end - this.turnStart;
    if (silence > PAUSE_TO_END || (elapsed > SOFT_LIMIT && silence > 0.3) || elapsed > HARD_LIMIT) {
      this.finishTurn();
    }
  }

  finishTurn() {
    if (!this.turn) return;
    this.queue.end(this.turn);
    this.turn = null;
  }
}
