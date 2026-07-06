/**
 * Link navigation, typed navigation, reload — all loopback. Every navigation
 * waits for the recorder in the NEW document via a since-wait, because corpus
 * URLs are stable across loads.
 */
export default async function run({ page, sessionUrl, gotoReady, frameReadySince }) {
  // Link click → navigate(link) into b.html.
  let before = Date.now();
  await page.click('#to-b');
  await frameReadySince(sessionUrl('b.html'), before);

  // Address-bar style navigation back to a.html → navigate(typed).
  await gotoReady(page, sessionUrl('a.html'));

  // Reload → navigate(reload). Same URL, so the since-wait is what makes the
  // readiness observation fresh.
  before = Date.now();
  await page.reload();
  await frameReadySince(sessionUrl('a.html'), before);
}
