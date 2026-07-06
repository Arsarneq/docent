/**
 * Container scroll past the significance floor → one settled scroll action.
 * The wait uses the recorder's own debounce constant, never a magic number.
 */
import {
  SCROLL_DEBOUNCE,
  SCROLL_MIN_DISTANCE_PX,
} from '../../../packages/extension/lib/capture-timing.js';

export default async function run({ page }) {
  await page.hover('#scrollbox');
  await page.mouse.wheel(0, SCROLL_MIN_DISTANCE_PX * 2);
  await page.waitForTimeout(SCROLL_DEBOUNCE + 200);
}
