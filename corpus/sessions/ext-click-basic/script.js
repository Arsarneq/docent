/** Click a button, an image, and an id-less button — three plain clicks. */
export default async function run({ page, vector }) {
  await page.click('#save');
  await vector?.mark('#save', 'save');
  await page.click('#logo');
  await vector?.mark('#logo', 'logo');
  await page.click('text=Plain');
  await vector?.mark('text=Plain', 'plain');
}
