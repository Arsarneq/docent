/**
 * Locators Tests (docent#132 / docent#172)
 *
 * Verifies capture-time emission of the measured `locators[]` candidates
 * (per-strategy match_count / match_index against the real page) and the
 * uniqueness-aware CSS selector derivation, including that the derived
 * selector genuinely resolves to the clicked element.
 */

import {
  test,
  expect,
  getPendingActions,
  clearPendingActions,
  waitForActionsToSettle,
  setTestContent,
} from '../helpers/extension-fixture.js';

function locatorOf(action, strategy) {
  return (action.element.locators ?? []).find((l) => l.strategy === strategy);
}

test.describe('Locator emission — duplicate elements', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <div class="card"><button data-testid="dup">Save</button></div>
    <div class="card"><button data-testid="dup">Save</button></div>
    <div class="card"><button data-testid="dup">Save</button></div>
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('clicking the 2nd of 3 identical buttons measures count 3, index 1', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.locator('button').nth(1).click();
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const click = actions.find((a) => a.type === 'click');
    expect(click, 'click captured').toBeTruthy();

    const testId = locatorOf(click, 'test_id');
    expect(testId).toMatchObject({
      attribute: 'data-testid',
      value: 'dup',
      match_count: 3,
      match_index: 1,
    });

    const text = locatorOf(click, 'text');
    expect(text).toMatchObject({ value: 'Save', match_count: 3, match_index: 1 });

    const tag = locatorOf(click, 'tag_name');
    expect(tag).toMatchObject({ value: 'button', match_count: 3, match_index: 1 });

    // The uniqueness-aware selector must single out the clicked element.
    const css = locatorOf(click, 'css');
    expect(css.value).toBe(click.element.selector);
    expect(css).toMatchObject({ match_count: 1, match_index: 0 });
    const resolved = testPage.locator(click.element.selector);
    await expect(resolved).toHaveCount(1);
    expect(await resolved.getAttribute('data-testid')).toBe('dup');
  });
});

test.describe('Locator emission — duplicate ids', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <section data-testid="top"><button id="dup-id">First</button></section>
    <section data-testid="bottom"><button id="dup-id">Second</button></section>
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('a duplicated id is counted, and the selector still resolves uniquely', async ({
    testPage,
    serviceWorker,
  }) => {
    await testPage.locator('button', { hasText: 'Second' }).click();
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const click = actions.find((a) => a.type === 'click');
    expect(click, 'click captured').toBeTruthy();

    expect(locatorOf(click, 'id')).toMatchObject({
      value: 'dup-id',
      match_count: 2,
      match_index: 1,
    });

    const resolved = testPage.locator(click.element.selector);
    await expect(resolved).toHaveCount(1);
    await expect(resolved).toHaveText('Second');
  });
});

test.describe('Locator emission — unique id fast path', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <button id="solo">Only me</button>
    <p>Some other content</p>
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('a unique id yields #id and a 1/0 pair', async ({ testPage, serviceWorker }) => {
    await testPage.click('#solo');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const click = actions.find((a) => a.type === 'click');
    expect(click.element.selector).toBe('#solo');
    expect(locatorOf(click, 'id')).toMatchObject({
      value: 'solo',
      match_count: 1,
      match_index: 0,
    });
    expect(locatorOf(click, 'css')).toMatchObject({
      value: '#solo',
      match_count: 1,
      match_index: 0,
    });
  });
});

test.describe('Locator masking — sensitive contenteditable', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <label for="ssn-box">Social security number</label>
    <div id="ssn-box" name="ssn" contenteditable="true" style="border:1px solid #999;min-height:1.5em;"></div>
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('the text entry is masked in place; identity entries and the pair survive', async ({
    testPage,
    serviceWorker,
  }) => {
    // contenteditable carries no name/type attributes for getAttribute-based
    // detection via the element description — but the ID pattern (ssn) is a
    // strong signal for the shared field-sensitivity util.
    await testPage.click('#ssn-box');
    await testPage.locator('#ssn-box').pressSequentially('123-45-6789');
    // The contenteditable capture debounces 500ms; blur flushes it.
    await testPage.locator('body').click({ position: { x: 5, y: 5 } });
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const typed = actions.find((a) => a.type === 'type' && a.element?.id === 'ssn-box');
    expect(typed, 'contenteditable type action captured').toBeTruthy();
    expect(typed.element.redacted).toBe(true);

    const text = locatorOf(typed, 'text');
    expect(text, 'text locator entry present (masked, never omitted)').toBeTruthy();
    expect(text.value).toBe('••••••••');
    expect(text.masked).toBe(true);
    expect(typeof text.match_count).toBe('number');

    const id = locatorOf(typed, 'id');
    expect(id.value).toBe('ssn-box');
    expect(id.masked).toBeUndefined();

    // The raw typed value must appear NOWHERE in stored actions.
    const json = JSON.stringify(actions);
    expect(json).not.toContain('123-45-6789');
  });
});
