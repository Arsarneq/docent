/**
 * File selection via the OS chooser proxy. The file is supplied as a buffer,
 * never a path — name/size/mime stay deterministic across machines instead of
 * riding the OS mime registry.
 */
export default async function run({ page, vector }) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#file')]);
  // Snapshot before setFiles: the input's value is still empty (text null).
  await vector?.mark('#file', 'file');
  await chooser.setFiles({
    name: 'hello.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello corpus\n'),
  });
}
