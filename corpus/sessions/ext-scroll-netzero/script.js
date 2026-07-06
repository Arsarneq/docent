/**
 * Net-zero jiggle inside one debounce window: down 300px, straight back up —
 * the transient movement fires IntersectionObservers but current capture
 * discards the settled net-zero scroll (docent#232). Truth carries the
 * settled scroll with zero net deltas. The trailing wait outlasts the
 * debounce so the settle is decided before the session ends.
 */
import { SCROLL_DEBOUNCE } from '../../../packages/extension/lib/capture-timing.js';

export default async function run({ page }) {
  await page.hover('#scrollbox');
  await page.mouse.wheel(0, 300);
  await page.mouse.wheel(0, -300); // same debounce window — no intermediate settle
  await page.waitForTimeout(SCROLL_DEBOUNCE + 200);
}
