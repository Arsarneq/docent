/** Click a button, an image, and an id-less button — three plain clicks. */
export default async function run({ page }) {
  await page.click('#save');
  await page.click('#logo');
  await page.click('text=Plain');
}
