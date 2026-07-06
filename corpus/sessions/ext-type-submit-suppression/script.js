/**
 * The canonical form flow docent#223 loses: type into a field, then click the
 * same-form submit button IMMEDIATELY — the change event lands inside the
 * mousedown suppression window and the typed value never enters the stream.
 * (An Enter-submit would not reproduce the suppression path.) Truth carries
 * the type action; the missing-action diff is the issue's baseline entry.
 */
export default async function run({ page, sessionUrl, frameReadySince }) {
  await page.click('#q');
  await page.keyboard.type('hello corpus');
  const before = Date.now();
  await page.click('#submit'); // no delay — the suppression path
  await frameReadySince(`${sessionUrl('form.html')}?q=hello+corpus`, before);
}
