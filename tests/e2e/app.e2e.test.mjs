import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { chromium } from 'playwright-core'

// Drives the production build (npm run build) in system Chrome against a throwaway database.
// Lithic is disabled so the run is deterministic; card-embed tests live in the manual checklist.

const ADMIN = { email: 'ops@stipend.demo', password: 'e2e-admin-password' }
const HOLDER = { email: 'lena.vogt@example.de', password: 'e2e-holder-password' }
let dir, server, browser, base

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stipend-e2e-'))
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, ['server/standalone.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LITHIC_API_KEY: '',
      SMTP_URL: '',
      LOG_LEVEL: 'warn',
      STIPEND_DATA_FILE: join(dir, 'e2e.sqlite'),
      STIPEND_ADMIN_PASSWORD: ADMIN.password,
      STIPEND_CARDHOLDER_PASSWORD: HOLDER.password,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' })
})

after(async () => {
  await browser?.close()
  server?.kill()
  rmSync(dir, { recursive: true, force: true })
})

async function signIn(page, { email, password }) {
  await page.goto(`${base}/login`)
  await page.fill('#login-email', email)
  await page.fill('#login-password', password)
  await page.click('button[type=submit]')
}

test('cardholder: dashboard, transaction detail with focus return, card and payment details', async () => {
  const context = await browser.newContext({ locale: 'en-GB' })
  const page = await context.newPage()
  await signIn(page, HOLDER)
  await page.waitForSelector('.kpis .kpi')
  assert.equal(await page.locator('.kpis .kpi').count(), 3)
  assert.match(await page.locator('.kpis .kpi').first().locator('h3').innerText(), /Wohngeld|Jobcenter|GKV/)

  await page.click('nav >> text=Transactions')
  const firstRow = page.locator('table.data tbody tr.clickable').first()
  await firstRow.focus()
  await page.keyboard.press('Enter')
  await page.waitForSelector('[role=dialog]')
  await page.keyboard.press('Tab')
  assert.ok(await page.evaluate(() => document.querySelector('[role=dialog]').contains(document.activeElement)))
  await page.keyboard.press('Escape')
  await page.waitForSelector('[role=dialog]', { state: 'detached' })
  assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('clickable')))

  await page.click('nav >> text=Card')
  await page.waitForSelector('.plastic')
  assert.match(await page.locator('.plastic-row').innerText(), /\*\*\*\* \*\*\*\* \*\*\*\*/)

  await page.click('nav >> text=Incoming')
  assert.match(await page.locator('.kv').first().innerText(), /DE\d{2}/)
  await context.close()
})

test('cardholder files a dispute on a settled purchase', async () => {
  const context = await browser.newContext({ locale: 'en-GB' })
  const page = await context.newPage()
  await signIn(page, HOLDER)
  await page.waitForSelector('.kpis')
  await page.click('nav >> text=Disputes')
  await page.selectOption('#reason', 'INCORRECT_AMOUNT')
  await page.fill('#note', 'Charged twice at the till')
  await page.click('form >> button[type=submit]')
  await page.waitForSelector('text=/recorded locally|submitted to Lithic/')
  assert.ok((await page.locator('.card table.data tbody tr').count()) >= 1)
  await context.close()
})

test('operator: signed credit through sandbox tools, recall, audit log', async () => {
  const context = await browser.newContext({ locale: 'en-GB' })
  const page = await context.newPage()
  await signIn(page, ADMIN)
  await page.waitForURL(/\/admin/)
  await page.goto(`${base}/admin/sandbox`)
  await page.selectOption('#sb-format', 'json')
  await page.fill('#sb-amount', '42.00')
  await page.click('text=Send signed request')
  await page.waitForSelector('text=HTTP 200')

  await page.goto(`${base}/admin/credits`)
  const row = page.locator('tr', { hasText: '42,00' }).or(page.locator('tr', { hasText: '42.00' })).first()
  await row.locator('button', { hasText: 'Recall' }).click()
  await page.click('[role=dialog] >> text=Recall credit')
  await page.waitForSelector('[role=dialog] >> text=/CNCL|PDCR/')
  await page.keyboard.press('Escape')

  await page.goto(`${base}/admin/audit`)
  await page.waitForSelector('code')
  const actions = await page.locator('table.data code').allInnerTexts()
  assert.ok(actions.some((a) => a.includes('/api/admin/credits/:id/recall')))
  assert.ok(actions.some((a) => a === 'auth.login'))
  await context.close()
})

test('operator creates a cardholder who must change the temporary password', async () => {
  const context = await browser.newContext({ locale: 'en-GB' })
  const page = await context.newPage()
  await signIn(page, ADMIN)
  await page.waitForURL(/\/admin/)
  await page.goto(`${base}/admin/cardholders/new`)
  await page.fill('#fn', 'Ada')
  await page.fill('#ln', 'Lovelace')
  await page.fill('#em', 'ada.e2e@example.test')
  await page.fill('#city', 'Paris')
  await page.click('button[type=submit]')
  const password = await page.locator('.secret-once code').innerText()
  await context.close()

  const fresh = await browser.newContext({ locale: 'en-GB' })
  const next = await fresh.newPage()
  await signIn(next, { email: 'ada.e2e@example.test', password })
  await next.waitForSelector('#pw-current')
  await next.fill('#pw-current', password)
  await next.fill('#pw-new', 'ada-new-password-1')
  await next.fill('#pw-repeat', 'ada-new-password-1')
  await next.click('button[type=submit]')
  await next.waitForSelector('.kpis')
  await fresh.close()
})

test('operator adds a cardholder to a cash rule from the list; the cardholder sees the limit', async () => {
  const adminContext = await browser.newContext({ locale: 'en-GB' })
  const admin = await adminContext.newPage()
  await signIn(admin, ADMIN)
  await admin.waitForURL((url) => !url.pathname.startsWith('/login'))
  await admin.goto(`${base}/admin/cardholders`)
  const rules = admin.locator('section.card', { hasText: 'Cash rules' })
  await rules.getByText('Standard cash allowance').waitFor()
  await admin.locator('select[aria-label="Cash rule for Lena Vogt"]').selectOption('cash_100_month')
  await rules.getByText('Lena Vogt').waitFor()

  const holderContext = await browser.newContext({ locale: 'en-GB' })
  const holder = await holderContext.newPage()
  await signIn(holder, HOLDER)
  await holder.waitForSelector('.cash-limit')
  assert.match(await holder.locator('.cash-limit').innerText(), /Cash limit[\s\S]*100\.00/)
  await holder.goto(`${base}/card`)
  await holder.waitForSelector('.cash-limit [role=meter]')

  // Turning cash off in bulk asks in an in-app dialog (never the browser's confirm), then removes the limit.
  admin.on('dialog', () => assert.fail('native browser dialog opened'))
  await admin.locator('input[aria-label="Select Lena Vogt"]').check()
  await admin.click('.bulk-bar >> text=Turn cash off')
  const confirm = admin.locator('[role=dialog]')
  await confirm.waitFor()
  assert.match(await confirm.locator('h2').innerText(), /Turn cash off for the selected cardholders\?/)
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await confirm.waitFor({ state: 'detached' })
  assert.equal(await rules.getByText('Lena Vogt').count(), 1)
  await admin.click('.bulk-bar >> text=Turn cash off')
  await confirm.getByRole('button', { name: 'Turn cash off' }).click()
  await rules.getByText('Lena Vogt').waitFor({ state: 'detached' })
  await holder.goto(`${base}/`)
  await holder.waitForSelector('.kpis .kpi')
  assert.equal(await holder.locator('.cash-limit').count(), 0)
  await adminContext.close()
  await holderContext.close()
})

test('operator settings: header link, country scope, program contact shown to cardholders', async () => {
  const adminContext = await browser.newContext({ locale: 'en-GB' })
  const admin = await adminContext.newPage()
  await signIn(admin, ADMIN)
  await admin.waitForURL((url) => !url.pathname.startsWith('/login'))
  await admin.goto(`${base}/admin`)
  assert.equal(await admin.locator('.topbar select').count(), 0)
  await admin.click('.topbar a[href="/admin/settings"]')
  await admin.waitForURL(`${base}/admin/settings`)
  await admin.locator('#set-country').selectOption('FR')
  await admin.goto(`${base}/admin/connections`)
  await admin.getByText(/Showing France only/).waitFor()

  await admin.goto(`${base}/admin/settings`)
  await admin.locator('#set-support-email').fill('hilfe@stipend.example.org')
  await admin.locator('section.card', { hasText: 'Program name' }).getByRole('button', { name: 'Save' }).click()
  await admin.locator('section.card', { hasText: 'Program name' }).getByText('Saved.').waitFor()
  const server = admin.locator('section.card', { hasText: 'Server configuration' })
  await server.getByRole('cell', { name: 'LITHIC_API_KEY' }).waitFor()
  assert.ok(!(await server.innerText()).includes('e2e-admin-password'))

  const holderContext = await browser.newContext({ locale: 'en-GB' })
  const holder = await holderContext.newPage()
  await signIn(holder, HOLDER)
  await holder.waitForURL((url) => !url.pathname.startsWith('/login'))
  await holder.goto(`${base}/settings`)
  await holder.locator('a[href="mailto:hilfe@stipend.example.org"]').waitFor()
  await adminContext.close()
  await holderContext.close()
})

test('cardholder settings: payment details, contact details, alert types, other devices', async () => {
  const context = await browser.newContext({ locale: 'en-GB' })
  const page = await context.newPage()
  await signIn(page, HOLDER)
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
  await page.click('.topbar a[href="/settings"]')
  await page.waitForURL(`${base}/settings`)
  await page.getByText('DE-BA-100042').waitFor()

  await page.locator('#profile-phone').fill('+49 30 555 0177')
  await page.locator('#profile-email').fill('lena.alt@example.de')
  await page.locator('#profile-password').waitFor()
  await page.locator('#profile-email').fill('lena.vogt@example.de')
  assert.equal(await page.locator('#profile-password').count(), 0)
  await page.locator('section.card', { hasText: 'Contact details' }).getByRole('button', { name: 'Save' }).click()
  await page.locator('section.card', { hasText: 'Contact details' }).getByText('Saved.').waitFor()

  const alerts = page.locator('section.card', { hasText: 'Email alerts' })
  await alerts.getByRole('button', { name: 'On' }).click()
  const cardAlerts = alerts.getByLabel('Card and wallet changes')
  await cardAlerts.waitFor()
  await cardAlerts.uncheck()
  await page.waitForFunction(() => !document.querySelector('input[name="alert-card"]')?.disabled)
  await page.reload()
  assert.equal(await page.getByLabel('Card and wallet changes').isChecked(), false)
  await page.getByLabel('Card and wallet changes').check()
  await page.locator('section.card', { hasText: 'Email alerts' }).getByRole('button', { name: 'Off' }).click()

  await page.getByRole('button', { name: 'Sign out other devices' }).click()
  await page.locator('[role=dialog]').getByRole('button', { name: 'Sign out other devices' }).click()
  await page.getByText('Active sign-ins: 1').waitFor()
  await context.close()
})
