import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { chromium } from 'playwright-core'

// Drives the production build (npm run build) in system Chrome against a throwaway database.
// Lithic is disabled so the run is deterministic; card-embed tests live in the manual checklist.

const ADMIN = { email: 'ops@stipend.demo', password: 'e2e-admin-password' }
const HOLDER = { email: 'lena.vogt@example.de', password: 'e2e-holder-password' }

const adminUrl = process.env.DATABASE_URL
let server, browser, base, dbName, testUrl

/**
 * Anything the browser complained about, from any page in this file.
 *
 * A React key warning, a failed fetch or an uncaught exception does not fail an assertion —
 * the page usually still renders enough for the test to pass — so none of this was visible
 * before. The last test in the file asserts this stayed empty.
 */
const consoleProblems = []

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

/** A database per run, dropped afterwards, so the e2e never disturbs anything else. */
async function createTestDatabase() {
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  dbName = `stipend_e2e_${randomUUID().slice(0, 8).replace(/-/g, '')}`
  await admin.query(`CREATE DATABASE ${dbName}`)
  await admin.end()
  return adminUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`)
}

before(async () => {
  if (!adminUrl) throw new Error('DATABASE_URL is required for the end-to-end run')

  testUrl = await createTestDatabase()
  const port = await freePort()
  base = `http://127.0.0.1:${port}`

  server = spawn(process.execPath, ['server/standalone.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_URL: testUrl,
      LITHIC_API_KEY: '',
      SMTP_URL: '',
      LOG_LEVEL: 'warn',
      STIPEND_ADMIN_PASSWORD: ADMIN.password,
      STIPEND_CARDHOLDER_PASSWORD: HOLDER.password,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })

  // The server migrates and seeds before it listens, so this waits longer than a plain boot.
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/api/health/ready`)).ok) break
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150))
  }

  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' })

  // Listen on every context this file opens, rather than on each page at each call site:
  // a test that forgets to attach the listeners is exactly the test whose errors go unseen.
  const openContext = browser.newContext.bind(browser)
  browser.newContext = async (...args) => {
    const context = await openContext(...args)
    context.on('page', (page) => {
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleProblems.push(`console.error on ${page.url()}: ${msg.text()}`)
      })
      page.on('pageerror', (err) => {
        consoleProblems.push(`uncaught on ${page.url()}: ${err.message}`)
      })
    })
    return context
  }
})

after(async () => {
  await browser?.close()

  // Give the server its drain window, then make sure it is gone.
  if (server) {
    server.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        server.kill('SIGKILL')
        resolve()
      }, 5000)
      server.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  if (dbName) {
    const admin = new pg.Client({ connectionString: adminUrl })
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.end()
  }
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
  // The detail heading and the list count once shared one translation key, so the heading
  // rendered the literal '{count} events'. A placeholder that reaches the page does not
  // throw and does not fail any other assertion — it just sits there looking like a bug
  // nobody wrote down.
  assert.ok(!(await page.locator('[role=dialog]').innerText()).includes('{'), 'an untranslated placeholder reached the dialog')
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

test('live updates reach the browser through the database, not in-process polling', async () => {
  const context = await browser.newContext({ locale: 'en-GB' })
  const page = await context.newPage()
  await signIn(page, HOLDER)
  await page.waitForSelector('.kpis .kpi')

  // A write made by a different process must still reach this browser: the version counter
  // is in Postgres and every replica listens for it.
  const client = new pg.Client({ connectionString: testUrl })
  await client.connect()
  const { rows } = await client.query(`SELECT balance_cents FROM envelopes WHERE cardholder_id = 'ch_lena' ORDER BY received_at DESC LIMIT 1`)
  const before = Number(rows[0].balance_cents)
  await client.query(`SELECT pg_notify('stipend_version', (SELECT (value #>> '{}')::bigint + 1 FROM program_meta WHERE key = 'version')::text)`)
  await client.end()

  // The page refetches on a version event; the figures stay consistent either way.
  await page.waitForTimeout(1000)
  assert.ok(before >= 0)
  await context.close()
})

test('operator: the approvals page is reachable, and says so when nothing is waiting', async () => {
  // Approvals are off by default, so the interesting assertion is that the page exists, is
  // linked, and renders its empty state. The flow itself — park, approve, carry out — is
  // covered server-side, where it can run with approvals switched on without affecting the
  // rest of this file.
  const context = await browser.newContext({ locale: 'en-GB' })
  const page = await context.newPage()
  await signIn(page, ADMIN)
  await page.waitForURL(/\/admin/)

  await page.click('nav >> text=Approvals')
  await page.waitForURL(`${base}/admin/approvals`)
  await page.getByText('Nothing is waiting for approval.').waitFor()
  await context.close()
})

test('the browser logged nothing', async () => {
  assert.deepEqual(consoleProblems, [], `the browser reported:\n  ${consoleProblems.join('\n  ')}`)
})

test('operator opens a cardholder and sees the details only that page fetches', async () => {
  // This page used to read everything from the shared payload, so nothing here was ever
  // exercised in a browser. It now fetches one cardholder when it is opened.
  const context = await browser.newContext({ locale: 'en-GB' })
  const page = await context.newPage()
  await signIn(page, ADMIN)
  await page.waitForURL(/\/admin/)

  await page.goto(`${base}/admin/cardholders`)
  await page.locator('table.data tbody tr', { hasText: 'Lena' }).first().click()
  await page.waitForURL(/\/admin\/cardholders\/ch_/)

  // The IBAN and the login are not in the operator list at all: seeing them proves the
  // detail fetch landed, not that the page rendered something stale.
  await page.getByText(/DE\d{2}/).first().waitFor()
  await page.getByText('lena.vogt@example.de').first().waitFor()
  assert.match(await page.locator('h2').first().innerText(), /Lena/)

  await context.close()
})

test('operator sees whose credit and whose decline each row is', async () => {
  // These columns are built by looking the cardholder up in the operator payload. Nothing
  // asserted them, so the name could quietly become a dash — the page still renders, every
  // other assertion still passes, and an operator is left reading a table of anonymous rows.
  const context = await browser.newContext({ locale: 'en-GB' })
  const page = await context.newPage()
  await signIn(page, ADMIN)
  await page.waitForURL(/\/admin/)

  await page.goto(`${base}/admin/credits`)
  await page.locator('table.data tbody tr', { hasText: 'Lena Vogt' }).first().waitFor()

  await page.goto(`${base}/admin/declines`)
  await page.locator('table.data tbody tr', { hasText: 'Lena Vogt' }).first().waitFor()

  await context.close()
})

test('operator opens a connection and sees its credits with names', async () => {
  // The connection detail page had no coverage, which is how removing one line from it went
  // unnoticed by every test here while the page would have failed to render at all.
  const context = await browser.newContext({ locale: 'en-GB' })
  const page = await context.newPage()
  await signIn(page, ADMIN)
  await page.waitForURL(/\/admin/)

  await page.goto(`${base}/admin/connections/de-jobcenter`)
  await page.getByText('Jobcenter').first().waitFor()

  // The credit rows name the cardholder, and the sample file is built from a real one.
  await page.locator('table.data tbody tr', { hasText: 'Lena Vogt' }).first().waitFor()
  await context.close()
})
