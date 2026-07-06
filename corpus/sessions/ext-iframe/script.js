/**
 * Clicks in the top document (frame_src: null) and inside an iframe
 * (frame_src: the frame's URL). The iframe's recorder readiness is observed
 * on the frame's own URL before acting in it.
 */
export default async function run({ page, sessionUrl, frameReady }) {
  await page.click('#top-btn');
  await frameReady(sessionUrl('frame.html'));
  await page.frameLocator('#frame').locator('#frame-btn').click();
}
