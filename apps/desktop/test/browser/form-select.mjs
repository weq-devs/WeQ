export async function chooseFormOption(field, value) {
  await field.click();
  const menuId = await field.getAttribute('aria-controls');
  const menu = field.page().locator(`[role="listbox"][id=${JSON.stringify(menuId)}]`);
  await menu.locator(`[role="option"][data-value=${JSON.stringify(String(value))}]`).click();
}

async function directorySortMenu(directory) {
  const trigger = directory.getByRole('button', { name: '排序', exact: true });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  return directory.page().getByRole('dialog', { name: '排序', exact: true });
}

export async function chooseDirectorySort(directory, value) {
  const menu = await directorySortMenu(directory);
  await menu
    .getByRole('listbox', { name: '排序依据', exact: true })
    .locator(`[role="option"][data-value=${JSON.stringify(String(value))}]`)
    .click();
}

export async function chooseDirectorySortDirection(directory, label) {
  const menu = await directorySortMenu(directory);
  await menu.getByRole('radio', { name: label, exact: true }).click();
}
