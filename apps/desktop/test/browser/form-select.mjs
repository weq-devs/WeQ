export async function chooseFormOption(field, value) {
  await field.click();
  const menuId = await field.getAttribute('aria-controls');
  const menu = field.page().locator(`[role="listbox"][id=${JSON.stringify(menuId)}]`);
  await menu.locator(`[role="option"][data-value=${JSON.stringify(String(value))}]`).click();
}
