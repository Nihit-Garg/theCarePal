import { useEffect, useRef } from 'react';

const WINDOW_S = 20;
const MAX_G = 6;

/** Live |a| traces for both devices with stage-2 scores on candidate peaks.
 * Draws from a mutable store on every animation frame (no React re-renders). */
export default function SignalChart({ store, thresholds }) {
  const ref = useRef(null);

  useEffect(() => {
    let raf;
    const canvas = ref.current;
    const ctx = canvas.getContext('2d');
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const css = getComputedStyle(canvas);
      const col = (v) => css.getPropertyValue(v).trim();
      const now = performance.now() / 1000;
      const x = (t) => w - ((now - t) / WINDOW_S) * w;
      const y = (g) => h - 14 - (Math.min(g, MAX_G) / MAX_G) * (h - 24);

      ctx.strokeStyle = col('--grid'); ctx.lineWidth = 1;
      ctx.fillStyle = col('--muted'); ctx.font = '11px system-ui';
      for (const g of [1, 2, 4]) {
        ctx.beginPath(); ctx.moveTo(0, y(g)); ctx.lineTo(w, y(g)); ctx.stroke();
        ctx.fillText(`${g} g`, 4, y(g) - 3);
      }
      for (const [id, color] of [['phone', '--phone'], ['wrist', '--wrist']]) {
        const pts = store.current.trace[id];
        ctx.strokeStyle = col(color); ctx.lineWidth = 1.6; ctx.beginPath();
        let started = false;
        for (const p of pts) {
          if (now - p.t > WINDOW_S) continue;
          if (!started) { ctx.moveTo(x(p.t), y(p.m)); started = true; } else ctx.lineTo(x(p.t), y(p.m));
        }
        ctx.stroke();
        for (const c of store.current.cands[id]) {
          if (now - c.t > WINDOW_S) continue;
          const fire = c.p >= thresholds[id];
          ctx.fillStyle = fire ? col('--danger') : col(color);
          ctx.beginPath(); ctx.arc(x(c.t), y(c.peakG), 4, 0, Math.PI * 2); ctx.fill();
          ctx.fillText(`${Math.round(c.p * 100)}%`, x(c.t) + 5, y(c.peakG) - 4);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [store, thresholds]);

  return (
    <div className="chart-wrap">
      <canvas ref={ref} className="chart" aria-label="Live acceleration magnitude for phone and wearable" />
      <div className="legend">
        <span><i className="dot phone" /> Phone |a|</span>
        <span><i className="dot wrist" /> Wearable |a|</span>
        <span><i className="dot danger" /> score above threshold</span>
      </div>
    </div>
  );
}
