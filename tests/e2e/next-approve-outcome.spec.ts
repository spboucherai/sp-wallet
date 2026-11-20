// NEXT W1 — once the approval has LEFT the browser, only a state read from the server decides what the Send screen shows.
//
//   tests/e2e/ui-stack.sh websafety 8790
//   SPW_E2E_BASE=http://localhost:8790 SPW_DEV_DIR=/tmp/spw-ui-websafety pnpm e2e next-approve-outcome.spec.ts
//
// Real stack for the session (owner setup, passkey, portfolio, networks); the TRANSFER routes are answered by the test
// (`page.route`), so that the answer of the approval can be lost on purpose and nothing is ever signed: the throwaway wallet
// holds no funds and the signer never sees these proposals. The passkey prompt is a real WebAuthn ceremony (virtual authenticator).
import { expect, test, type Page, type Route } from '@playwright/test';
import { openWallet } from './v11-helpers.ts';

const ID = '7b0c5c0e-3a54-4f0e-9d7b-0c1f6f2a9e11', TO = '0x1111111111111111111111111111111111111111';
const proposal = (state: string, more: Record<string, unknown> = {}) => ({ id: ID, state, network: 'base', networkName: 'Base', asset: 'native', symbol: 'ETH', decimals: 18, amount: '10000000000000000', amountDisplay: '0.01',
  from: '0x2222222222222222222222222222222222222222', to: TO, note: '', memo: null, feeDisplay: '0.000002', maxFeeDisplay: '0.00001', feeSymbol: 'ETH', warnings: [], intentHash: 'ab'.repeat(32), txid: null, explorer: null,
  confirmations: 0, error: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), ...more });
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

interface Server { state: string; readable: boolean; rejectWorks: boolean; creates: string[]; approves: number; rejects: number; createFailsOnce: boolean }
/** the transfer routes, played by the test: `approve` is always LOST (the request is seen, its answer never arrives) */
async function fakeTransfers(page: Page): Promise<Server> {
  const s: Server = { state: 'draft', readable: false, rejectWorks: false, creates: [], approves: 0, rejects: 0, createFailsOnce: true };
  await page.route('**/api/v1/transfers/proposals', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    s.creates.push(route.request().headers()['idempotency-key'] ?? '');
    if (s.createFailsOnce) { s.createFailsOnce = false; return route.abort('failed'); }   // the answer of the creation is lost once: the retry must carry the SAME key
    s.state = 'draft'; return json(route, proposal('draft'));
  });
  await page.route(`**/api/v1/transfers/proposals/${ID}/request-approval`, (route) => { s.state = 'pending_approval';
    return json(route, { proposal: proposal('pending_approval'), options: { challenge: 'c3B3LW5leHQtZTJlLWNoYWxsZW5nZS0wMDAwMDAwMDAwMDA', rpId: 'localhost', userVerification: 'required', timeout: 60_000 } }); });
  await page.route(`**/api/v1/transfers/proposals/${ID}/approve`, (route) => { s.approves++; return route.abort('failed'); });
  await page.route(`**/api/v1/transfers/proposals/${ID}/reject`, (route) => { s.rejects++; return s.rejectWorks ? json(route, proposal('rejected')) : route.abort('failed'); });
  await page.route(`**/api/v1/transfers/proposals/${ID}`, (route) => (s.readable ? json(route, proposal(s.state, s.state === 'broadcast' ? { txid: '0x' + 'cd'.repeat(32) } : {})) : route.abort('failed')));
  return s;
}
async function toReview(page: Page, s: Server): Promise<void> {
  await page.goto('/send');
  await expect(page.getByTestId('send-steps')).toBeVisible();
  await page.locator('textarea').fill(TO);
  await page.getByPlaceholder('0.00').fill('0.01');
  await expect(page.getByTestId('send-review')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('send-review').click();                       // lost answer → an error, the form stays
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('textarea')).toHaveValue(TO);
  await page.getByTestId('send-review').click();                       // the retry of the same form
  await expect(page.getByTestId('send-approve')).toBeVisible();
  expect(s.creates.length).toBe(2);
  expect(s.creates[0]).toMatch(/^[0-9a-f-]{36}$/); expect(s.creates[1]).toBe(s.creates[0]);   // one draft, one key, however many network retries
}
const noFreshSend = async (page: Page) => {
  await expect(page.getByTestId('send-approve')).toHaveCount(0);       // no Approve
  await expect(page.getByTestId('send-cancel')).toHaveCount(0);        // no Cancel that would reset the form
  await expect(page.getByTestId('send-review')).toHaveCount(0);        // not back on the form
  await expect(page.getByText(/échou|failed/i)).toHaveCount(0);        // never "failed"
};

test.describe.configure({ mode: 'serial' });
test('approve answer lost, state unreadable → "checking", then "status unknown — do not send again"; a later check shows what the server says', async ({ page, context, baseURL }) => {
  test.setTimeout(150_000);
  const w = await openWallet(page, context, baseURL), s = await fakeTransfers(page);
  await toReview(page, s);
  await page.getByTestId('send-approve').click();
  await expect(page.getByTestId('approval-checking')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('approval-checking')).toContainText('Vérification de ce qui s’est passé');
  await noFreshSend(page);
  await expect(page.getByTestId('approval-unknown')).toBeVisible({ timeout: 40_000 });   // five reads over about fifteen seconds, all lost
  await expect(page.getByTestId('approval-unknown')).toContainText('État inconnu — n’envoyez pas de nouveau');
  await expect(page.getByTestId('approval-recheck')).toBeVisible(); await expect(page.getByTestId('approval-activity')).toBeVisible();
  await noFreshSend(page);
  expect(s.approves).toBe(1); expect(s.rejects).toBe(0); expect(s.creates.length).toBe(2);   // nothing was sent again, nothing was cancelled
  await expect(page.getByText(TO.slice(0, 6)).first()).toBeVisible();   // the review (amount, destination) is still on screen

  // still unreadable: checking again changes nothing
  await page.getByTestId('approval-recheck').click();
  await expect(page.getByTestId('approval-checking')).toBeVisible();
  await expect(page.getByTestId('approval-unknown')).toBeVisible({ timeout: 40_000 });
  await noFreshSend(page);

  // the server can be read again and says the transfer was relayed: that state is shown — tracking, not a new send
  s.state = 'broadcast'; s.readable = true;
  await page.getByTestId('approval-recheck').click();
  await expect(page.getByRole('heading', { name: 'Suivi du transfert' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('approval-unknown')).toHaveCount(0);
  await expect(page.getByText('0x' + 'cd'.repeat(32))).toBeVisible();
  expect(s.approves).toBe(1);
  await w.save();
});

test('approve answer lost, the server says the approval never arrived → approving again is allowed; a cancellation that fails says so and resets nothing', async ({ page, context, baseURL }) => {
  test.setTimeout(150_000);
  const w = await openWallet(page, context, baseURL), s = await fakeTransfers(page);
  await toReview(page, s);
  s.readable = true;                                                    // readable, and still `pending_approval`
  await page.getByTestId('send-approve').click();
  await expect(page.getByTestId('approval-checking')).toBeVisible({ timeout: 20_000 });
  await noFreshSend(page);
  await expect(page.getByTestId('approval-not-received')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('send-approve')).toBeVisible();        // the SERVER said nothing was signed
  // cancel: the rejection is lost → said, and the review stays (same proposal, same form)
  await page.getByTestId('send-cancel').click();
  await expect(page.getByText(/L’annulation n’a pas pu être confirmée/)).toBeVisible();
  await expect(page.getByTestId('send-approve')).toBeVisible(); await expect(page.getByTestId('send-review')).toHaveCount(0);
  expect(s.rejects).toBe(1);
  // the rejection goes through: back to an empty form
  s.rejectWorks = true;
  await page.getByTestId('send-cancel').click();
  await expect(page.getByTestId('send-review')).toBeVisible();
  await expect(page.locator('textarea')).toHaveValue('');
  await w.save();
});
