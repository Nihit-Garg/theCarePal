// Small shared formatting / download helpers (used by several views).

export function timeStr(t = Date.now()) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const deviceName = (id) => (id === 'wrist' ? 'wearable' : 'phone');

/** scores: { phone: p | {p}, wrist: p | {p} } (null entries skipped) -> "phone 97% · wearable 61%" */
export function scoresText(scores, sep = ' · ') {
  return Object.entries(scores || {})
    .filter(([, v]) => v != null)
    .map(([id, v]) => `${deviceName(id)} ${Math.round((typeof v === 'number' ? v : v.p) * 100)}%`)
    .join(sep);
}

/** Save text as a file (CSV exports). */
export function downloadText(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
