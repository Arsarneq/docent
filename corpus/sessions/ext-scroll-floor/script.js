/**
 * Scroll a container whose whole range (150px) is under the significance
 * floor — the user scrolled it to the bottom, and current capture discards
 * the action entirely (docent#232). Truth carries the settled scroll.
 */
import { SCROLL_DEBOUNCE } from '../../../packages/extension/lib/capture-timing.js';

export default async function run({ page }) {
  await page.hover('#scrollbox');
  await page.mouse.wheel(0, 300); // clamps at the 150px maximum
  await page.waitForTimeout(SCROLL_DEBOUNCE + 200);
}
