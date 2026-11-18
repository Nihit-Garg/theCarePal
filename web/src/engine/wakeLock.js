// Keeps the screen on while the phone's own sensor is in use. Browsers stop
// delivering DeviceMotion events when the screen locks, so without this a
// web-based detector silently stops working. (A native app wouldn't need it.)
import { useEffect, useState } from 'react';

export function useWakeLock(active) {
  const [state, setState] = useState('off'); // off | on | unsupported | error
  useEffect(() => {
    if (!active) { setState('off'); return; }
    if (!('wakeLock' in navigator)) { setState('unsupported'); return; }
    let lock = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request('screen');
        if (cancelled) { lock.release(); return; }
        setState('on');
        lock.addEventListener('release', () => !cancelled && setState('off'));
      } catch {
        setState('error');
      }
    };
    // the lock is dropped whenever the tab is hidden; take it again on return
    const onVis = () => document.visibilityState === 'visible' && acquire();
    acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      lock?.release().catch(() => {});
    };
  }, [active]);
  return state;
}
