/** Captured control keys on a focused input, one of them pressed while another is held. */
export default async function run({ page }) {
  await page.click('#field');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  // A key pressed while another is held names the held key.
  await page.keyboard.down('ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.up('ArrowDown');
}
