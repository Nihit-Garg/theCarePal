// End-to-end smoke test: serves the production build, drives it in headless
// Chrome at phone size, and checks the real user flows.
//   npm run build && npm run smoke            (needs Google Chrome installed,
//   or set CHROME_PATH to a Chrome/Chromium binary)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = 4179;
const OUT = process.env.SMOKE_OUT || 'smoke-output';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(OUT, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => d.toString().includes(String(PORT)) && resolve());
  server.on('exit', (c) => reject(new Error(`preview exited ${c}`)));
  setTimeout(() => reject(new Error('preview did not start')), 15000);
});

const results = [];
// Close any alert still on screen (e.g. one that fired after a wait timed out) so it
// can't block the next step; returns what it closed.
async function dismissAny(page) {
  const ok = page.getByRole('button', { name: "I'm OK — cancel" });
  if (await ok.isVisible().catch(() => false)) { await ok.click(); return 'late alert'; }
  const done = page.getByRole('button', { name: 'Done' });
  if (await done.isVisible().catch(() => false)) { await done.click(); return 'expired alert'; }
  return null;
}
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); };
// --mute-audio + alert sound/voice off: the alert's alarm tone and spoken prompt must never
// come out of the developer's speakers while the test plays falls.
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--mute-audio'] });
// one context = one browser profile: tabs share localStorage + BroadcastChannel, like real tabs
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
await context.addInitScript(() => localStorage.setItem('fallguard.alertFx', JSON.stringify({ sound: false, voice: false })));
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
context.on('page', (p) => p.on('pageerror', (e) => errors.push(`[2nd tab] ${e.message}`)));
page.on('pageerror', (e) => errors.push(e.message));

try {
  await page.goto(`http://localhost:${PORT}${process.env.VITE_BASE || '/'}`);
  await page.getByRole('heading', { name: 'Live signal' }).waitFor({ timeout: 20000 });
  check('models + replays load', true);
  await page.getByLabel('Normal day in background').uncheck();
  await page.locator('.pill', { hasText: 'Phone + wearable (fused)' }).waitFor({ timeout: 5000 });
  check('both devices streaming → fused mode', true);
  await page.waitForTimeout(5000); // let the chart and heart rate fill in
  await page.screenshot({ path: `${OUT}/1-dashboard.png`, fullPage: true });

  // every fall replay should raise an alert (fused mode)
  const falls = await page.locator('.chip.fall').allTextContents();
  let detected = 0;
  for (let i = 0; i < falls.length; i++) {
    const leftover = await dismissAny(page);
    if (leftover) console.log(`      (closed a ${leftover} before fall #${i})`);
    await page.locator('.chip.fall').nth(i).click();
    const hit = await page.getByText('Possible fall detected').waitFor({ timeout: 20000 }).then(() => true, () => false);
    if (hit) {
      detected++;
      if (detected === 1) await page.screenshot({ path: `${OUT}/2-alert.png` });
      await page.getByRole('button', { name: "I'm OK — cancel" }).click();
    }
    console.log(`      ${falls[i]} (#${i}): ${hit ? 'alert' : 'missed'}`);
  }
  check('fall replays raise the alert', detected >= falls.length - 1, `${detected}/${falls.length}`);
  check('cancel is logged', await page.getByText('Alert cancelled — person is OK').first().isVisible());

  // "Get help now" escalates; a caregiver in ANOTHER TAB sees it live, acknowledges and resolves it
  const carer = await page.context().newPage();
  await carer.setViewportSize({ width: 390, height: 844 });
  await carer.goto(`http://localhost:${PORT}${process.env.VITE_BASE || '/'}#/caregiver`);
  await carer.getByRole('heading', { name: 'Caregiver' }).waitFor({ timeout: 10000 });
  check('caregiver view lists the cancelled alerts', await carer.getByText('Cancelled by Asha (demo)').first().isVisible());

  await page.locator('.chip.fall').first().click();
  await page.getByText('Possible fall detected').waitFor({ timeout: 20000 });
  await page.waitForTimeout(4000); // let heart rate rise
  await page.getByRole('button', { name: 'Get help now' }).click();
  await page.getByText('Your caregiver has been alerted').waitFor({ timeout: 5000 });
  await page.getByText('Waiting for a caregiver to respond').waitFor({ timeout: 5000 });
  check('person sees "waiting for a caregiver"', true);

  await carer.getByText('Asked for help — needs someone now').waitFor({ timeout: 5000 });
  await carer.screenshot({ path: `${OUT}/5-caregiver-alert.png`, fullPage: true });
  check('caregiver tab gets the escalation live', true);
  await carer.getByRole('button', { name: "I'm on it" }).click();
  await page.getByText('Nurse Priya is responding').waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${OUT}/3-notified.png` });
  check('person sees who is responding', true);
  await carer.getByLabel('Resolution note').fill('Found on the floor, helped up, no injury');
  await carer.getByRole('button', { name: 'Real fall' }).click();
  await carer.locator('.badge.fall').first().waitFor({ timeout: 5000 });
  const confirmed = await carer.locator('.stats div', { hasText: 'confirmed falls' }).locator('b').textContent();
  check('resolution recorded in history + stats', confirmed === '1', `confirmed falls = ${confirmed}`);
  await carer.screenshot({ path: `${OUT}/6-caregiver-history.png`, fullPage: true });
  await page.getByRole('button', { name: 'Done' }).click();

  // Hindi alert
  await page.getByRole('radio', { name: 'हिन्दी' }).click();
  await page.locator('.chip.fall').nth(2).click();
  await page.getByText('गिरने का पता चला है').waitFor({ timeout: 20000 });
  await page.screenshot({ path: `${OUT}/7-alert-hindi.png` });
  await page.getByRole('button', { name: 'मैं ठीक हूँ' }).click();
  check('alert in Hindi', true);
  await page.getByRole('radio', { name: 'English' }).click();

  // everyday activities should not alarm (one take of each of the 11 activities, played in full)
  const adls = await page.locator('.chips').nth(1).locator('.chip').allTextContents();
  let falseAlarms = 0;
  for (let i = 0; i < adls.length; i++) {
    const leftover = await dismissAny(page);
    if (leftover) { falseAlarms++; console.log(`      (closed a ${leftover} before activity #${i} — counted as a false alarm)`); }
    await page.locator('.chips').nth(1).locator('.chip').nth(i).click();
    // wait for the whole clip (~15 s) + 1 s transition + 2.5 s look-ahead + fused decision wait
    const fa = await page.getByText('Possible fall detected').waitFor({ timeout: 23000 }).then(() => true, () => false);
    if (fa) { falseAlarms++; await page.getByRole('button', { name: "I'm OK — cancel" }).click(); }
    console.log(`      ${adls[i]}: ${fa ? 'FALSE ALARM' : 'ok'}`);
  }
  check('everyday activities mostly do not alarm', falseAlarms <= 1, `${falseAlarms}/${adls.length} false alarms`);

  // recorder: record a few seconds, label, download CSV
  await page.getByText('Record data for real-world testing').click();
  await page.getByRole('button', { name: '● Start recording' }).click();
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'walking', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: '■ Stop recording' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ Download CSV' }).click()]);
  const csvPath = `${OUT}/recording.csv`;
  await download.saveAs(csvPath);
  const csv = (await import('node:fs')).readFileSync(csvPath, 'utf8').trim().split('\n');
  check('recorder exports a labelled CSV', csv[0] === 't,device,ax,ay,az,hr,event,detail' && csv.length > 100
    && csv.some((l) => l.includes('mark_activity,walking')), `${csv.length - 1} rows`);

  // fallback logic
  await page.getByLabel('Worn').uncheck();
  await page.locator('.pill', { hasText: /^Phone$/ }).waitFor({ timeout: 5000 });
  check('wearable taken off → phone only', true);
  await page.getByLabel('Worn').check();
  await page.getByRole('radio', { name: 'Off' }).click();
  await page.locator('.pill', { hasText: /^Wearable$/ }).waitFor({ timeout: 5000 });
  check('phone off → wearable only', true);
  await page.getByLabel('Connected').uncheck();
  await page.locator('.pill', { hasText: 'No sensor' }).waitFor({ timeout: 5000 });
  check('nothing connected → warning', await page.getByText('No sensor is active').isVisible());
  await page.screenshot({ path: `${OUT}/4-no-sensor.png`, fullPage: true });

  // side-by-side view (wide screens) for demos
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://localhost:${PORT}${process.env.VITE_BASE || '/'}#/split`);
  await page.getByRole('heading', { name: 'Live signal' }).waitFor({ timeout: 20000 });
  await page.getByRole('heading', { name: 'Caregiver' }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/8-split.png` });
  check('side-by-side view renders both screens', true);

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('flow completed', false, err.message);
  await page.screenshot({ path: `${OUT}/error.png`, fullPage: true });
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
