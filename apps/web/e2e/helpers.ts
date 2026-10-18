import { expect, type Page } from '@playwright/test';

let counter = 0;
export const uniqueEmail = () => `shopper${Date.now()}${++counter}@example.com`;
export const PASSWORD = 'password123';

export async function register(page: Page, opts: { next?: string; name?: string; phone?: string } = {}) {
  const email = uniqueEmail();
  await page.goto(`/register${opts.next ? `?next=${encodeURIComponent(opts.next)}` : ''}`);
  await page.getByLabel('Full name').fill(opts.name ?? 'Asha Rawat');
  await page.getByLabel('Email').fill(email);
  if (opts.phone) await page.getByLabel(/Mobile number/).fill(opts.phone);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  // Registration is asynchronous: wait for the signed-in header so the next step cannot interrupt it.
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  return email;
}

export async function addTeeToCart(page: Page, size = 'M') {
  await page.goto('/products/e2e-tee');
  await page.getByRole('button', { name: size, exact: true }).click();
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page.getByText('Added to your cart.')).toBeVisible();
}

export async function addAddress(page: Page, over: { state?: string; city?: string; pincode?: string } = {}) {
  await page.getByRole('button', { name: /Add (a delivery|another) address/ }).click();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByLabel('Address line 1').fill('12 Rajpur Road');
  await page.getByLabel('City').fill(over.city ?? 'Dehradun');
  await page.getByLabel('Pincode').fill(over.pincode ?? '248001');
  await page.getByLabel('State').selectOption(over.state ?? 'Uttarakhand');
  await page.getByRole('button', { name: 'Save address' }).click();
}

export const formError = (page: Page) => page.locator('p.error-text[role="alert"]');
export const cartLink = (page: Page) => page.getByRole('link', { name: /^Cart/ });


/** Signs up, puts a tee in the cart, checks out with a Dehradun address and lands on the new unpaid order. */
export async function placeUnpaidOrder(page: Page, opts: { quantity?: number } = {}) {
  await register(page);
  await addTeeToCart(page);
  if (opts.quantity && opts.quantity > 1) {
    await page.goto('/cart');
    await page.getByLabel('Qty').selectOption(String(opts.quantity));
    await expect(page.getByText(`Subtotal (${opts.quantity} items)`)).toBeVisible();
  }
  await page.goto('/checkout');
  await addAddress(page);
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/orders\/[a-z0-9]+$/);
  await expect(page.getByText('Awaiting payment').first()).toBeVisible();
  return page.url();
}
