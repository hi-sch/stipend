import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '../i18n/I18n.jsx'
import CashLimit, { nextCashReset } from './CashLimit.jsx'
import TransactionTable from './TransactionTable.jsx'

/**
 * Components that decide something, rendered to markup.
 *
 * Effects do not run in a static render, so the translation provider stays on its English
 * source text — which is all these need. The end-to-end run drives real Chrome for anything
 * involving a click; this is the layer underneath, where a status quietly reads as the wrong
 * colour or a meter goes past full.
 */
const render = (el) => renderToStaticMarkup(<MemoryRouter><I18nProvider>{el}</I18nProvider></MemoryRouter>)

test('a cash period rolls forward by its own length', () => {
  assert.equal(nextCashReset({ periodStart: '2026-03-10T00:00:00.000Z', period: 'DAY' }), '2026-03-11T00:00:00.000Z')
  assert.equal(nextCashReset({ periodStart: '2026-03-10T00:00:00.000Z', period: 'WEEK' }), '2026-03-17T00:00:00.000Z')
  assert.equal(nextCashReset({ periodStart: '2026-03-01T00:00:00.000Z', period: 'MONTH' }), '2026-04-01T00:00:00.000Z')

  // Anything unknown is treated as a month rather than throwing, because this renders a date
  // on a cardholder's card page and must not take the page down.
  assert.equal(nextCashReset({ periodStart: '2026-03-01T00:00:00.000Z', period: undefined }), '2026-04-01T00:00:00.000Z')
})

test('a month that starts on the 31st rolls past February', () => {
  // setUTCMonth overflows: the 31st of January plus one month is the 3rd of March. This is
  // safe only because periodStart comes from date_trunc('month') and is always the first, so
  // the assumption is written down here rather than left to be discovered.
  assert.equal(nextCashReset({ periodStart: '2026-01-31T00:00:00.000Z', period: 'MONTH' }), '2026-03-03T00:00:00.000Z')
})

test('no cash rule means no meter at all', () => {
  assert.equal(render(<CashLimit usage={null} />), '')
  assert.equal(render(<CashLimit usage={undefined} />), '')
})

test('the cash meter reports what is left, and never more than full', () => {
  const markup = render(
    <CashLimit usage={{ usedCents: 2500, limitCents: 10000, remainingCents: 7500, period: 'MONTH', periodStart: '2026-09-01T00:00:00.000Z' }} />,
  )
  assert.match(markup, /role="meter"/)
  assert.match(markup, /aria-valuenow="2500"/)
  assert.match(markup, /aria-valuemax="10000"/)
  assert.match(markup, /width:25%/)

  // Spending past the limit is possible — a cleared authorization can land above it — and the
  // bar must not run off the end of its track when it does.
  const over = render(
    <CashLimit usage={{ usedCents: 30000, limitCents: 10000, remainingCents: 0, period: 'MONTH', periodStart: '2026-09-01T00:00:00.000Z' }} />,
  )
  assert.match(over, /width:100%/)
})

const txn = (over = {}) => ({
  id: 'txn_1',
  merchant: { descriptor: 'REWE', city: 'Berlin', mcc: '5411' },
  created: '2026-09-10T10:00:00.000Z',
  status: 'SETTLED',
  amountCents: 1234,
  ...over,
})

test('an empty transaction table says so instead of rendering a head with no body', () => {
  assert.match(render(<TransactionTable rows={[]} envelopeName={() => 'x'} />), /class="empty"/)
})

test('a transaction row is coloured by what happened to it', () => {
  const settled = render(<TransactionTable rows={[txn()]} envelopeName={() => 'Jobcenter'} />)
  assert.match(settled, /badge ok">SETTLED/)

  const declined = render(<TransactionTable rows={[txn({ status: 'DECLINED', note: 'No envelope pays 5411' })]} envelopeName={() => '—'} />)
  assert.match(declined, /badge bad">DECLINED/)
  assert.match(declined, /No envelope pays 5411/, 'a declined purchase says why on the row')

  // Pending is neither: it has not succeeded and it has not failed.
  assert.match(render(<TransactionTable rows={[txn({ status: 'PENDING' })]} envelopeName={() => 'x'} />), /badge warn">PENDING/)
})

test('a note is shown only when the transaction went nowhere', () => {
  // A settled purchase carrying an internal note must not show it as if it were a problem.
  const settledWithNote = render(<TransactionTable rows={[txn({ note: 'internal' })]} envelopeName={() => 'x'} />)
  // The row has to be there for its absence to mean anything: without this the assertion
  // below would pass just as happily against a component that rendered nothing at all.
  assert.match(settledWithNote, /REWE/, 'the row rendered')
  assert.ok(!settledWithNote.includes('internal'), 'but the note did not')
})

test('rows are only clickable when there is something to open', () => {
  const plain = render(<TransactionTable rows={[txn()]} envelopeName={() => 'x'} />)
  assert.ok(!plain.includes('clickable'))

  const selectable = render(<TransactionTable rows={[txn()]} envelopeName={() => 'x'} onSelect={() => {}} />)
  assert.match(selectable, /class="clickable"/)
  assert.match(selectable, /tabindex="0"/, 'and reachable by keyboard, not only by mouse')
})
