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
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); };
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
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

  // "Get help now" sends the caregiver message
  await page.locator('.chip.fall').first().click();
  await page.getByText('Possible fall detected').waitFor({ timeout: 20000 });
  await page.waitForTimeout(4000); // let heart rate rise
  await page.getByRole('button', { name: 'Get help now' }).click();
  await page.getByText('Caregiver notified').first().waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${OUT}/3-notified.png` });
  check('caregiver message shown', true);
  await page.getByRole('button', { name: 'Done' }).click();

  // everyday activities should not alarm
  const adls = await page.locator('.chips').nth(1).locator('.chip').allTextContents();
  let falseAlarms = 0;
  for (let i = 0; i < adls.length; i++) {
    await page.locator('.chips').nth(1).locator('.chip').nth(i).click();
    const fa = await page.getByText('Possible fall detected').waitFor({ timeout: 9000 }).then(() => true, () => false);
    if (fa) { falseAlarms++; await page.getByRole('button', { name: "I'm OK — cancel" }).click(); }
    console.log(`      ${adls[i]}: ${fa ? 'FALSE ALARM' : 'ok'}`);
  }
  check('everyday activities mostly do not alarm', falseAlarms <= 1, `${falseAlarms}/${adls.length} false alarms`);

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
