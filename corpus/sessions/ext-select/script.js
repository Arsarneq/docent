/**
 * Keyboard-driven native select: trusted click + ArrowDown x2 + Enter.
 * Playwright's selectOption dispatches UNTRUSTED change events the recorder
 * correctly drops, so it must never drive this session (the
 * browser-chrome.spec.js precedent).
 */
export default async function run({ page }) {
  await page.click('#color');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}
