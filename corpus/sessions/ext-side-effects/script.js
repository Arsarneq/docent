/**
 * Clicks whose handlers fire programmatic scroll/focus/value changes and a
 * synthetic change event. Truth = the two clicks only — the action-vs-effect
 * boundary (and the docent#224 class boundary) pinned as corpus truth.
 */
import { SCROLL_DEBOUNCE } from '../../../packages/extension/lib/capture-timing.js';

export default async function run({ page }) {
  await page.click('#trigger');
  // Wait out the scroll debounce so a wrongly-captured programmatic scroll
  // would have settled into the stream before the session ends.
  await page.waitForTimeout(SCROLL_DEBOUNCE + 200);
  await page.click('#plain');
}
