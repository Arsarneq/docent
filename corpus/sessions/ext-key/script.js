/** Captured control keys on a focused input. */
export default async function run({ page }) {
  await page.click('#field');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
}
