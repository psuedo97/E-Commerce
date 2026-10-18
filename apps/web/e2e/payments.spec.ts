import { createHmac } from 'crypto';
import { expect, test, type Page } from '@playwright/test';
import { cartLink, placeUnpaidOrder, register } from './helpers';

// The browser-test API runs with the built-in test-mode gateway (no Razorpay keys), whose signature
// scheme is HMAC-SHA256 with this secret. The Razorpay-window tests below sign like the real thing would.
const MOCK_SECRET = 'mock-secret';
const sign = (orderId: string, paymentId: string) => createHmac('sha256', MOCK_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

const payButton = (page: Page) => page.getByRole('button', { name: /^Pay ₹/ });

test.describe('paying in test mode', () => {
  test('an unpaid order offers a Pay button with the exact total', async ({ page }) => {
    await placeUnpaidOrder(page);
    await expect(payButton(page)).toHaveText('Pay ₹649');
    await expect(page.getByText(/Complete payment to confirm your order/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel order' })).toBeVisible();
  });

  test('a successful payment marks the order paid and removes the payment controls', async ({ page }) => {
    await placeUnpaidOrder(page);
    await payButton(page).click();
    await expect(page.getByTestId('test-mode')).toBeVisible();
    await expect(page.getByText(/No real payment provider is connected/)).toBeVisible();

    await page.getByRole('button', { name: 'Simulate successful payment' }).click();

    await expect(page.getByText(/Payment received. We have emailed your confirmation/)).toBeVisible();
    await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Awaiting payment')).toHaveCount(0);
    await expect(payButton(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0); // paid orders cannot be cancelled online
    await expect(page.getByText(/held for \d+ more minute/)).toHaveCount(0);
  });

  test('a paid order stays paid after a reload and shows in the order list', async ({ page }) => {
    const url = await placeUnpaidOrder(page);
    await payButton(page).click();
    await page.getByRole('button', { name: 'Simulate successful payment' }).click();
    await expect(page.getByText('Payment received.').first()).toBeVisible();

    await page.reload();
    await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
    await expect(payButton(page)).toHaveCount(0);

    await page.goto('/orders');
    await expect(page.locator('.order-row').first()).toContainText('Paid');
    await page.goto(url);
    await expect(page.getByRole('heading', { name: /Order #\d+/ })).toContainText('Paid');
  });

  test('a failed payment leaves the order unpaid and the customer can try again', async ({ page }) => {
    await placeUnpaidOrder(page);
    await payButton(page).click();
    await page.getByRole('button', { name: 'Simulate failed payment' }).click();

    await expect(page.getByText('The payment did not go through. You can try again.')).toBeVisible();
    await expect(page.getByText('Awaiting payment').first()).toBeVisible();
    await expect(payButton(page)).toBeVisible();

    await payButton(page).click();
    await page.getByRole('button', { name: 'Simulate successful payment' }).click();
    await expect(page.getByText('Payment received.').first()).toBeVisible();
    await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
  });

  test('a failed attempt is remembered when the page is reloaded', async ({ page }) => {
    await placeUnpaidOrder(page);
    await payButton(page).click();
    await page.getByRole('button', { name: 'Simulate failed payment' }).click();
    await expect(page.getByText('The payment did not go through.')).toBeVisible();

    await page.reload();
    await expect(page.getByText('Your last payment attempt did not go through. You can try again.')).toBeVisible();
    await expect(payButton(page)).toBeVisible();
  });

  test('a cancelled order has no payment controls', async ({ page }) => {
    await placeUnpaidOrder(page);
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Cancel order' }).click();
    await expect(page.getByText('Cancelled').first()).toBeVisible();
    await expect(payButton(page)).toHaveCount(0);
    await expect(page.getByText(/Complete payment/)).toHaveCount(0);
  });

  test('explains a refund when an order was cancelled after the customer paid (items sold out)', async ({ page }) => {
    const url = await placeUnpaidOrder(page);
    // The real situation (payment lands after stock ran out) is covered by the API tests; here we check the page copes
    // with the resulting order: cancelled, but with money taken.
    await page.route('**/api/v1/orders/*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const order = await res.json();
      await route.fulfill({ response: res, json: { ...order, status: 'CANCELLED', expiresAt: null, payment: { status: 'REFUNDED', provider: 'razorpay', amount: order.total } } });
    });
    await page.goto(url);
    await expect(page.getByTestId('sold-out-refund')).toContainText('sold out while your payment was being completed');
    await expect(page.getByTestId('sold-out-refund')).toContainText('₹649');
    await expect(payButton(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
  });

  test('a plain cancelled order (never paid) does not mention a refund', async ({ page }) => {
    await placeUnpaidOrder(page);
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Cancel order' }).click();
    await expect(page.getByText('Cancelled').first()).toBeVisible();
    await expect(page.getByTestId('sold-out-refund')).toHaveCount(0);
  });

  test('the full journey: shop, check out, pay, and the cart is empty afterwards', async ({ page }) => {
    await placeUnpaidOrder(page, { quantity: 2 });
    await expect(payButton(page)).toHaveText('Pay ₹1,198'); // above the free-delivery threshold
    await payButton(page).click();
    await page.getByRole('button', { name: 'Simulate successful payment' }).click();
    await expect(page.getByText('Payment received.').first()).toBeVisible();
    await expect(cartLink(page)).not.toContainText('2');
  });

  test('someone else cannot see or pay for the order', async ({ page, browser }) => {
    const url = await placeUnpaidOrder(page);
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await register(otherPage);
    await otherPage.goto(url);
    await expect(otherPage.getByRole('heading', { name: 'Order not found' })).toBeVisible();
    await expect(payButton(otherPage)).toHaveCount(0);
    await other.close();
  });
});

test.describe("paying through Razorpay's payment window", () => {
  /**
   * Makes the API answer "pay" as if Razorpay were configured, and replaces Razorpay's script with a
   * stand-in. `mode` decides what the stand-in window does; success signs the payment properly so the
   * API's real signature check runs.
   */
  async function useFakeRazorpay(page: Page, mode: 'success' | 'bad-signature' | 'fail' | 'dismiss') {
    await page.exposeFunction('__sign', (orderId: string, paymentId: string) => sign(orderId, paymentId));
    await page.route('**/api/v1/orders/*/pay', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, provider: 'razorpay', keyId: 'rzp_test_browser' } });
    });
    await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `
          window.Razorpay = function (options) { this.options = options; this.handlers = {}; };
          window.Razorpay.prototype.on = function (event, handler) { this.handlers[event] = handler; };
          window.Razorpay.prototype.open = function () {
            window.__razorpayOptions = this.options;
            var mode = ${JSON.stringify(mode)};
            var self = this;
            if (mode === 'fail') return self.handlers['payment.failed']({ error: { description: 'Card declined by your bank' } });
            if (mode === 'dismiss') return self.options.modal.ondismiss();
            var paymentId = 'pay_browser_1';
            Promise.resolve(window.__sign(self.options.order_id, paymentId)).then(function (signature) {
              self.options.handler({
                razorpay_order_id: self.options.order_id,
                razorpay_payment_id: paymentId,
                razorpay_signature: mode === 'bad-signature' ? 'f'.repeat(64) : signature,
              });
            });
          };`,
      }),
    );
  }

  test('opens the window with the right order details and confirms a successful payment', async ({ page }) => {
    await useFakeRazorpay(page, 'success');
    await placeUnpaidOrder(page);
    await payButton(page).click();

    await expect(page.getByText(/Payment received. We have emailed your confirmation/)).toBeVisible();
    await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('test-mode')).toHaveCount(0); // it was the Razorpay path, not the test panel

    const options = await page.evaluate(() => (window as unknown as { __razorpayOptions: Record<string, unknown> }).__razorpayOptions);
    expect(options).toMatchObject({
      key: 'rzp_test_browser', amount: 64900, currency: 'INR', name: 'KOMA',
      prefill: { name: 'Asha Rawat' },
    });
    expect(String(options.order_id)).toMatch(/^order_mock_/);
    expect(String(options.description)).toMatch(/^Order #\d+$/);
  });

  test('a payment the server cannot verify is not treated as paid', async ({ page }) => {
    await useFakeRazorpay(page, 'bad-signature');
    await placeUnpaidOrder(page);
    await payButton(page).click();

    await expect(page.getByText(/We could not confirm your payment yet/)).toBeVisible();
    await page.reload();
    await expect(page.getByText('Awaiting payment').first()).toBeVisible(); // still unpaid
    await expect(payButton(page)).toBeVisible();
  });

  test("shows the bank's reason when the card is declined, and lets the customer retry", async ({ page }) => {
    await useFakeRazorpay(page, 'fail');
    await placeUnpaidOrder(page);
    await payButton(page).click();
    await expect(page.getByText('Card declined by your bank')).toBeVisible();
    await expect(page.getByText('Awaiting payment').first()).toBeVisible();
    await expect(payButton(page)).toBeEnabled();
  });

  test('closing the window without paying is handled gracefully', async ({ page }) => {
    await useFakeRazorpay(page, 'dismiss');
    await placeUnpaidOrder(page);
    await payButton(page).click();
    await expect(page.getByText('The payment window was closed. You can try again whenever you are ready.')).toBeVisible();
    await expect(payButton(page)).toBeEnabled();
    await expect(page.getByText('Awaiting payment').first()).toBeVisible();
  });

  test('explains a blocked or unreachable payment script instead of failing silently', async ({ page }) => {
    await page.route('**/api/v1/orders/*/pay', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), provider: 'razorpay', keyId: 'rzp_test_browser' } });
    });
    await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) => route.abort());
    await placeUnpaidOrder(page);
    await payButton(page).click();
    await expect(page.getByText(/Could not reach the payment provider/)).toBeVisible();
    await expect(payButton(page)).toBeEnabled();
  });
});
