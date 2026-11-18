// Tiny persisted preferences (language, sound, caregiver name). localStorage can
// be unavailable (private mode, blocked storage), so every access is guarded and
// the app works with defaults.
import { useEffect, useState } from 'react';

export function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(`fallguard.${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    localStorage.setItem(`fallguard.${key}`, JSON.stringify(value));
  } catch {
    // not persisted; fine for a demo
  }
}

export function usePref(key, fallback) {
  const [v, setV] = useState(() => readPref(key, fallback));
  useEffect(() => writePref(key, v), [key, v]);
  return [v, setV];
}
