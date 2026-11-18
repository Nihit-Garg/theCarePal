// Making the alert impossible to miss: an alarm tone (Web Audio), vibration
// (Android; iOS Safari has no Vibration API) and a spoken prompt (Web Speech).
// Browsers only allow audio after a user gesture, so call unlockAudio() from
// any click first — the demo does it on the first tap anywhere.

let ctx = null;

export function unlockAudio() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null; // no Web Audio: alert still works visually
  }
}

function beep(freq, startAt, dur, gain = 0.25) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, startAt);
  g.gain.linearRampToValueAtTime(gain, startAt + 0.01);
  g.gain.setValueAtTime(gain, startAt + dur - 0.02);
  g.gain.linearRampToValueAtTime(0, startAt + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + dur);
}

export function speak(text, lang) {
  if (!('speechSynthesis' in window) || !text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = 0.9; // a little slower: clearer for older listeners
  const voice = window.speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith(lang.slice(0, 2)));
  if (voice) u.voice = voice;
  window.speechSynthesis.speak(u);
}

/** Start the alarm. Returns stop(). Options: { sound, voice, text, lang }. */
export function startAlarm({ sound = true, voice = true, text = '', lang = 'en-IN' } = {}) {
  let stopped = false;
  const timers = [];
  if (sound && ctx) {
    const ring = () => {
      if (stopped) return;
      const t0 = ctx.currentTime + 0.02;
      beep(988, t0, 0.18); beep(740, t0 + 0.22, 0.18); beep(988, t0 + 0.44, 0.18);
      timers.push(setTimeout(ring, 1600));
    };
    ring();
  }
  if (navigator.vibrate) {
    const buzz = () => { if (!stopped) { navigator.vibrate([500, 250, 500]); timers.push(setTimeout(buzz, 2000)); } };
    buzz();
  }
  if (voice) timers.push(setTimeout(() => !stopped && speak(text, lang), 700)); // after the first beeps
  return () => {
    stopped = true;
    timers.forEach(clearTimeout);
    navigator.vibrate?.(0);
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  };
}

/** A short chime for the caregiver screen when an incident needs attention. */
export function attentionChime() {
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.02;
  beep(660, t0, 0.15, 0.2); beep(880, t0 + 0.18, 0.25, 0.2);
}
