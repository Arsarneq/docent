/**
 * Drag the pointer-capture slider thumb: down on the thumb, move in steps,
 * release over the track — the gesture docent#231 shows collapsing to a stray
 * click or nothing. Truth carries drag_start + drop.
 */
export default async function run({ page }) {
  const thumb = await page.locator('#thumb').boundingBox();
  const startX = thumb.x + thumb.width / 2;
  const startY = thumb.y + thumb.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(startX + i * 40, startY);
  }
  await page.mouse.up();
}
