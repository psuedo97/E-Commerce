import { expect, test } from '@playwright/test';
import { addAddress, addTeeToCart, cartLink, formError, PASSWORD, register, uniqueEmail } from './helpers';

test.describe('browsing and the cart', () => {
  test('product page shows price, sizes and disables a sold-out size', async ({ page }) => {
    await page.goto('/products/e2e-tee');
    await expect(page.getByRole('heading', { name: 'E2E Tee' })).toBeVisible();
    await expect(page.getByText('₹599').first()).toBeVisible();
    await expect(page.getByText('25% off')).toBeVisible();
    await expect(page.getByRole('button', { name: 'S', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'L', exact: true })).toBeDisabled();
  });

  test('a guest adds to the cart, sees the badge, and keeps the cart after a reload', async ({ page }) => {
    await page.goto('/');
    await addTeeToCart(page);
    await expect(cartLink(page)).toContainText('1');

    await page.reload();
    await expect(cartLink(page)).toContainText('1'); // remembered via the stored cart id

    await page.goto('/cart');
    await expect(page.getByText('E2E Tee')).toBeVisible();
    await expect(page.getByText('M', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Subtotal (1 item)')).toBeVisible();
    await expect(page.getByText('₹599').first()).toBeVisible();
  });

  test('quantity and removal update the totals', async ({ page }) => {
    await addTeeToCart(page);
    await page.goto('/cart');
    await page.getByLabel('Qty').selectOption('3');
    await expect(page.getByText('Subtotal (3 items)')).toBeVisible();
    await expect(page.getByText('₹1,797').first()).toBeVisible();

    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Your cart is empty')).toBeVisible();
  });

  test('an empty cart offers a way back to shopping', async ({ page }) => {
    await page.goto('/cart');
    await expect(page.getByText('Your cart is empty')).toBeVisible();
    await page.getByRole('link', { name: 'Start shopping' }).click();
    await expect(page).toHaveURL(/\/products/);
  });
});

test.describe('accounts', () => {
  test('registering signs you in, and the login survives a page reload', async ({ page }) => {
    await register(page, { name: 'Meera Negi' });
    await expect(page).toHaveURL('/');
    await expect(page.getByText('Hi, Meera')).toBeVisible();

    await page.reload(); // the in-memory token is gone; the refresh cookie must restore the session
    await expect(page.getByText('Hi, Meera')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  });

  test('logging out clears the session and protects account pages', async ({ page }) => {
    await register(page);
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible(); // cookie was cleared too
    await page.goto('/orders');
    await expect(page).toHaveURL(/\/login\?next=(%2F|\/)orders/);
  });

  test('a wrong password shows the error and stays on the login page', async ({ page }) => {
    const email = await register(page);
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(formError(page)).toHaveText('Invalid email or password');
    await expect(page).toHaveURL(/\/login/);
  });

  test('logging in returns you to the page you wanted', async ({ page }) => {
    const email = await register(page);
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.goto('/orders');
    await expect(page).toHaveURL(/\/login\?next=(%2F|\/)orders/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL('/orders');
    await expect(page.getByRole('heading', { name: 'Your orders' })).toBeVisible();
  });

  test('an external "next" address cannot be used to bounce you off the site', async ({ page }) => {
    await register(page, { next: 'https://evil.example/phish' });
    await expect(page).toHaveURL('http://localhost:3100/');
  });

  test('registration errors are shown (duplicate email)', async ({ page }) => {
    const email = await register(page);
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.goto('/register');
    await page.getByLabel('Full name').fill('Someone Else');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel(/^Password/).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(formError(page)).toContainText('already exists');
  });
});

test.describe('checkout', () => {
  test('guest to paid-ready order: add, register at checkout (cart is kept), address, place, cancel', async ({ page }) => {
    // 1. As a guest, put a tee in the cart and head to checkout.
    await addTeeToCart(page);
    await page.goto('/cart');
    await page.getByRole('link', { name: 'Proceed to checkout' }).click();
    await expect(page).toHaveURL(/\/login\?next=(%2F|\/)checkout/);

    // 2. Create an account. The guest cart must be merged into it, and we land back on checkout.
    await page.getByRole('link', { name: 'Create an account' }).click();
    await page.getByLabel('Full name').fill('Asha Rawat');
    await page.getByLabel('Email').fill(uniqueEmail());
    await page.getByLabel(/^Password/).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL('/checkout');
    await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
    await expect(page.getByText('E2E Tee (M) × 1')).toBeVisible();

    // 3. No address yet: add one. Delivery inside Uttarakhand: Rs 50 shipping, CGST + SGST.
    await addAddress(page);
    await expect(page.getByText('12 Rajpur Road')).toBeVisible();
    await expect(page.getByText('₹50')).toBeVisible();
    await expect(page.getByText('₹649').last()).toBeVisible();
    await expect(page.getByText(/CGST ₹18\.07 \+ SGST ₹18\.08/)).toBeVisible();

    // 4. Place the order.
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/orders\/[a-z0-9]+$/);
    await expect(page.getByRole('heading', { name: /Order #\d+/ })).toBeVisible();
    await expect(page.getByText('Awaiting payment').first()).toBeVisible();
    await expect(page.getByText('E2E Tee (M) × 1')).toBeVisible();
    await expect(page.getByText('₹649').last()).toBeVisible();
    await expect(page.getByText(/held for \d+ more minute/)).toBeVisible();
    await expect(cartLink(page)).not.toContainText('1'); // cart was emptied

    // 5. Cancel it.
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Cancel order' }).click();
    await expect(page.getByText('Cancelled').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);

    // 6. It shows in the order list.
    await page.goto('/orders');
    await expect(page.getByText(/Order #\d+/).first()).toBeVisible();
    await expect(page.getByText('Cancelled')).toBeVisible();
  });

  test('collecting from the shop is free and priced with CGST + SGST', async ({ page }) => {
    await register(page);
    await addTeeToCart(page);
    await page.goto('/checkout');
    await page.getByLabel('Collect from our shop').check();
    await expect(page.getByText('KOMA Store, Dehradun')).toBeVisible();
    // This account has no phone number on file, so one is needed for pickup updates.
    await expect(page.getByRole('button', { name: 'Place order' })).toBeDisabled();
    await page.getByLabel(/Mobile number for pickup/).fill('9876500000');
    await expect(page.getByText('Free', { exact: true })).toBeVisible();
    await expect(page.getByText('₹599').last()).toBeVisible();
    await expect(page.getByText(/CGST/)).toBeVisible();

    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/orders\/[a-z0-9]+$/);
    await expect(page.getByText('KOMA Store, Dehradun')).toBeVisible();
    await expect(page.getByText(/We will call 9876500000/)).toBeVisible();
  });

  test('delivering to another state switches the tax to IGST', async ({ page }) => {
    await register(page);
    await addTeeToCart(page);
    await page.goto('/checkout');
    await addAddress(page, { state: 'Maharashtra', city: 'Pune', pincode: '411001' });
    await expect(page.getByText(/IGST ₹36\.15/)).toBeVisible();
    await expect(page.getByText(/CGST/)).toHaveCount(0);
  });

  test('switching between saved addresses re-prices the order', async ({ page }) => {
    await register(page);
    await addTeeToCart(page);
    await page.goto('/checkout');
    await addAddress(page); // Uttarakhand
    await expect(page.getByText(/CGST/)).toBeVisible();
    await addAddress(page, { state: 'Delhi', city: 'New Delhi', pincode: '110001' });
    await expect(page.getByText(/IGST/)).toBeVisible();
    await page.getByRole('radio', { name: /Dehradun/ }).check();
    await expect(page.getByText(/CGST/)).toBeVisible();
  });

  test('free delivery kicks in above the threshold', async ({ page }) => {
    await register(page);
    await addTeeToCart(page);
    await page.goto('/cart');
    await page.getByLabel('Qty').selectOption('2'); // Rs 1,198
    await page.goto('/checkout');
    await addAddress(page);
    await expect(page.getByText('Free', { exact: true })).toBeVisible();
    await expect(page.getByText('₹1,198').last()).toBeVisible();
  });

  test('address form rejects a bad mobile number before sending', async ({ page }) => {
    await register(page);
    await addTeeToCart(page);
    await page.goto('/checkout');
    await page.getByRole('button', { name: 'Add a delivery address' }).click();
    await page.getByLabel('Mobile number').fill('12345');
    await page.getByLabel('Address line 1').fill('12 Rajpur Road');
    await page.getByLabel('City').fill('Dehradun');
    await page.getByLabel('Pincode').fill('248001');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByRole('button', { name: 'Save address' })).toBeVisible(); // still open: HTML validation blocked it
    await expect(page.getByLabel('Address line 1')).toBeVisible();
  });

  test('checkout with an empty cart points back to shopping', async ({ page }) => {
    await register(page);
    await page.goto('/checkout');
    await expect(page.getByText('Your cart is empty')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue shopping' })).toBeVisible();
  });

  test('order pages are private to their owner', async ({ page, browser }) => {
    await register(page);
    await addTeeToCart(page);
    await page.goto('/checkout');
    await addAddress(page);
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/orders\/[a-z0-9]+$/);
    const orderUrl = page.url();

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await register(otherPage);
    await otherPage.goto(orderUrl);
    await expect(otherPage.getByRole('heading', { name: 'Order not found' })).toBeVisible();
    await other.close();
  });
});
