/**
 * Type into a field, then blur by clicking a neutral button — never Tab (the
 * Tab-correlated focus capture rides a correlation window; click-away keeps
 * the session's truth deterministic).
 */
export default async function run({ page }) {
  await page.click('#email');
  await page.keyboard.type('user@example.com');
  await page.click('#elsewhere');
}
