/**
 * Type into a field, then blur by clicking a neutral button — never Tab (the
 * Tab-correlated focus capture rides a correlation window; click-away keeps
 * the session's truth deterministic).
 */
export default async function run({ page, vector }) {
  await page.click('#email');
  // Snapshot before typing: the field's value is still empty (text null).
  await vector?.mark('#email', 'email');
  await page.keyboard.type('user@example.com');
  await page.click('#elsewhere');
}
