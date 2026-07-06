/**
 * Context lifecycle: user opens a tab via a target=_blank link, switches back
 * to the original tab, then closes the new tab. b.html is a DISTINCT URL from
 * a.html — the frame-ready probe is keyed per URL and must never see two live
 * tabs share one.
 */
export default async function run({ page, context, sessionUrl, frameReadySince }) {
  const before = Date.now();
  const [newPage] = await Promise.all([context.waitForEvent('page'), page.click('#open-b')]);
  await frameReadySince(sessionUrl('b.html'), before);

  // Switch back to the original tab (context_switch)…
  await page.bringToFront();
  // …give the tab-switch proxy a beat, then close the opened tab (context_close).
  await page.waitForTimeout(300);
  await newPage.close();
}
