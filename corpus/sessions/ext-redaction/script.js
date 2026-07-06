/**
 * Sensitive-value capture: a password (inline-masked by the recorder), a
 * cc-number field (masked at the service-worker chokepoint), and a sensitive
 * select whose element text exists — its text-strategy locator must be masked
 * IN PLACE with the exact mask glyphs and masked: true.
 */
export default async function run({ page }) {
  await page.click('#password');
  await page.keyboard.type('hunter2secret');
  await page.click('#cc-number');
  await page.keyboard.type('4111111111111111');
  await page.click('#cc-exp');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}
