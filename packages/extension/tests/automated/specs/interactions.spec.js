/**
 * Interactions Tests
 *
 * Verifies capture of file uploads, drag & drop, iframes, form submission,
 * contenteditable, password masking, double-click, shadow DOM, and
 * programmatic variants of each.
 */

import { test, expect, getPendingActions, clearPendingActions, waitForActionsToSettle, setTestContent } from '../helpers/extension-fixture.js';

test.describe('File Upload', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <input id="file-user" type="file">
    <button id="btn">Button</button>
    <input id="file-prog" type="file">
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('user file upload produces file_upload action', async ({ testPage, serviceWorker }) => {
    const [fileChooser] = await Promise.all([
      testPage.waitForEvent('filechooser'),
      testPage.click('#file-user'),
    ]);
    await fileChooser.setFiles({
      name: 'test.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    });
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // User clicked the file input (click) and selected a file (file_upload).
    expect(types).toEqual(['click', 'file_upload']);
    const fileAction = actions.find(a => a.type === 'file_upload');
    expect(fileAction.files[0].name).toBe('test.txt');
  });

  test('programmatic file assignment should NOT be captured', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          const dt = new DataTransfer();
          dt.items.add(new File(['content'], 'fake.txt', { type: 'text/plain' }));
          document.getElementById('file-prog').files = dt.files;
          document.getElementById('file-prog').dispatchEvent(new Event('change', { bubbles: true }));
        }, 200);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });
});

test.describe('Drag and Drop', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <div id="source" draggable="true" style="width:100px;height:100px;background:#ccc;">Drag</div>
    <div id="target" style="width:200px;height:200px;background:#eee;margin-top:20px;">Drop here</div>
    <button id="btn">Button</button>
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('user drag and drop produces drag_start and drop actions', async ({ testPage, serviceWorker }) => {
    await testPage.dragAndDrop('#source', '#target');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['drag_start', 'drop']);
  });

  test('programmatic drag events should NOT be captured', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          const source = document.getElementById('source');
          const target = document.getElementById('target');
          source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
          target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
        }, 200);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });
});

test.describe('Iframe', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <iframe id="frame" srcdoc='<button id="iframe-btn" style="padding:1rem">Click inside iframe</button>' width="400" height="100"></iframe>
    <button id="btn">Outer button</button>
    <iframe id="frame-prog" srcdoc='<button id="prog-btn">Programmatic target</button>' width="400" height="80"></iframe>
    <iframe id="frame-nav" srcdoc="<p>Original</p>" width="400" height="60"></iframe>
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(500);
    await clearPendingActions(serviceWorker);
  });

  test('click inside iframe is captured', async ({ testPage, serviceWorker }) => {
    const frame = testPage.frameLocator('#frame');
    await frame.locator('#iframe-btn').click();
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });

  test('programmatic click inside iframe should NOT be captured', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          const iframe = document.getElementById('frame-prog');
          const btn = iframe.contentDocument?.getElementById('prog-btn');
          if (btn) btn.click();
        }, 200);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });

  test('programmatic iframe navigation should NOT produce navigate action', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          document.getElementById('frame-nav').srcdoc = '<p>Navigated!</p>';
        }, 200);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });
});

test.describe('Contenteditable', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <div id="editable" contenteditable="true" style="border:1px solid #ccc;padding:0.5rem;min-height:2rem;"></div>
    <button id="blur-target">Blur</button>
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('typing in contenteditable should produce a type action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#editable');
    await clearPendingActions(serviceWorker);
    await testPage.type('#editable', 'hello');
    await testPage.click('#blur-target');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const typeActions = actions.filter(a => a.type === 'type');
    // Ideal: typing in contenteditable should be captured as a type action.
    expect(typeActions.length).toBe(1);
    expect(typeActions[0].value).toContain('hello');
  });
});

test.describe('Password Masking', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <input id="password" type="password">
    <button id="btn">Blur</button>
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('password value is masked in captured actions', async ({ testPage, serviceWorker }) => {
    await testPage.click('#password');
    await testPage.fill('#password', 'secret123');
    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const typeActions = actions.filter(a => a.type === 'type');
    // Ideal: 1 type action with masked value.
    expect(typeActions.length).toBe(1);
    expect(typeActions[0].value).toBe('••••••••');
    // No action should contain the raw password anywhere.
    const json = JSON.stringify(actions);
    expect(json).not.toContain('secret123');
  });
});

test.describe('Double-Click', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <p id="text" style="padding:1rem;">Double-click this text.</p>
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('double-click produces two click actions', async ({ testPage, serviceWorker }) => {
    await testPage.dblclick('#text');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // Ideal: exactly 2 clicks, nothing else.
    expect(types).toEqual(['click', 'click']);
  });
});

test.describe('Shadow DOM', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <div id="host"></div>
    <script>
      const host = document.getElementById('host');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<button id="shadow-btn" style="padding:1rem;">Shadow Button</button>';
    </script>
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('click inside shadow DOM is captured', async ({ testPage, serviceWorker }) => {
    await testPage.locator('#host').locator('button').click();
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });
});

test.describe('Programmatic Right-Click', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <button id="btn">Click me</button>
    <p id="target">Right-click target</p>
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('programmatic contextmenu dispatch should NOT be captured', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          document.getElementById('target').dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, clientX: 100, clientY: 100,
          }));
        }, 200);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });
});

test.describe('Programmatic .click()', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <button id="btn">Trigger</button>
    <button id="hidden" style="display:none;">Hidden</button>
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('programmatic element.click() should NOT be captured', async ({ testPage, serviceWorker }) => {
    await testPage.evaluate(() => {
      document.getElementById('btn').addEventListener('click', () => {
        setTimeout(() => {
          document.getElementById('hidden').click();
        }, 200);
      });
    });

    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    expect(types).toEqual(['click']);
  });
});



test.describe('Form Submission — User Action', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <form id="form" method="GET" action="">
      <input id="input" name="q" type="text" placeholder="Type then submit">
      <button id="submit" type="submit">Submit</button>
    </form>
  </body></html>`;

  test('user form submit via button click produces only click — navigate is a side-effect', async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await testPage.fill('#input', 'test query');
    await clearPendingActions(serviceWorker);

    await testPage.click('#submit');
    await testPage.waitForTimeout(1000);
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // The user clicked the submit button. That's the action.
    // The form navigation is the effect of clicking submit.
    expect(types).toEqual(['click']);
  });
});

test.describe('Contenteditable — Empty Attribute', () => {
  const PAGE_HTML = /* html */ `<!DOCTYPE html>
  <html><body>
    <div id="editable" contenteditable="" style="border:1px solid #ccc;padding:0.5rem;min-height:2rem;"></div>
    <button id="blur-target">Blur</button>
  </body></html>`;

  test.beforeEach(async ({ testPage, serviceWorker }) => {
    await setTestContent(testPage, PAGE_HTML);
    await testPage.waitForTimeout(200);
    await clearPendingActions(serviceWorker);
  });

  test('typing in contenteditable="" should produce a type action', async ({ testPage, serviceWorker }) => {
    await testPage.click('#editable');
    await clearPendingActions(serviceWorker);
    await testPage.type('#editable', 'world');
    await testPage.click('#blur-target');
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const typeActions = actions.filter(a => a.type === 'type');
    expect(typeActions.length).toBe(1);
    expect(typeActions[0].value).toContain('world');
  });
});

test.describe('Return to Tab', () => {

  test('switching back to a tab produces context_switch', async ({ testPage, serviceWorker, context }) => {
    await setTestContent(testPage, '<html><body><p>Main</p></body></html>');
    await testPage.waitForTimeout(200);

    const otherPage = await context.newPage();
    await otherPage.goto('https://example.com');
    await otherPage.bringToFront();
    await testPage.waitForTimeout(300);
    await clearPendingActions(serviceWorker);

    // User switches back — this IS a user action.
    await testPage.bringToFront();
    await waitForActionsToSettle(serviceWorker, testPage);

    const actions = await getPendingActions(serviceWorker);
    const types = actions.map(a => a.type);
    // Ideal: exactly 1 context_switch, nothing else.
    expect(types).toEqual(['context_switch']);

    await otherPage.close();
  });
});
