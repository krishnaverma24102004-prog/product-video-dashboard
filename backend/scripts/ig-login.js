// One-time interactive login: opens a real browser, YOU log in, the session is saved locally.
// Your password is typed into instagram.com only; this script never sees or stores it.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../src/config.js';

fs.mkdirSync(path.dirname(config.igStatePath), { recursive: true });

// Prefer an installed browser: Playwright's bundled Chromium can be blocked by Windows Smart App Control.
async function launchVisible() {
  const channels = process.env.LOGIN_BROWSER ? [process.env.LOGIN_BROWSER] : ['msedge', 'chrome', undefined];
  let lastErr;
  for (const channel of channels) {
    try {
      const b = await chromium.launch({ headless: false, ...(channel ? { channel } : {}) });
      console.log(`Opened ${channel || 'bundled Chromium'}.`);
      return b;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const browser = await launchVisible();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 }, locale: 'en-US' });
const page = await ctx.newPage();
await page.goto('https://www.instagram.com/accounts/login/');
console.log('\nLog in to Instagram in the opened browser window (2FA included).');
console.log('Waiting up to 5 minutes for a logged-in session...\n');

const deadline = Date.now() + 5 * 60_000;
let ok = false;
while (Date.now() < deadline) {
  const cookies = await ctx.cookies('https://www.instagram.com');
  const sid = cookies.find((c) => c.name === 'sessionid' && c.value);
  if (sid && !/\/accounts\/(login|onetap|challenge)/.test(page.url())) {
    ok = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 1500));
}
if (!ok) {
  console.error('Timed out without a logged-in session.');
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(2000);
await ctx.storageState({ path: config.igStatePath });
console.log(`Session saved to ${config.igStatePath}\n(This file is gitignored. Treat it like a password.)`);
await browser.close();
