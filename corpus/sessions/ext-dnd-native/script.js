/** Native HTML5 drag and drop: drag_start + drop with source_element. */
export default async function run({ page }) {
  await page.dragAndDrop('#drag', '#drop');
}
