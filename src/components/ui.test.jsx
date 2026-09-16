import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorText, KeyValues, OkText, Section, StatusBadge } from './ui.jsx'

/**
 * The shared pieces every page is built from, rendered to markup.
 *
 * These are static renders, not a browser: the end-to-end run already drives real Chrome for
 * anything involving a click. What was missing was the layer underneath — what a component
 * puts on the page for a given set of props. That is where a wrong key, a dropped value or a
 * status that quietly reads as a warning lives, and none of it failed anything before.
 */

const html = (el) => renderToStaticMarkup(el)

test('a status badge colours by meaning, not by string', () => {
  assert.equal(html(<StatusBadge status="SETTLED" />), '<span class="badge ok">SETTLED</span>')
  assert.equal(html(<StatusBadge status="APPLIED" />), '<span class="badge ok">APPLIED</span>', 'a carried-out approval reads as good')
  assert.equal(html(<StatusBadge status="FAILED" />), '<span class="badge bad">FAILED</span>')
  assert.equal(html(<StatusBadge status="EXPIRED" />), '<span class="badge bad">EXPIRED</span>')

  // Anything unknown is a warning rather than a silent success: a status nobody has
  // classified should look like it needs attention.
  assert.equal(html(<StatusBadge status="PENDING" />), '<span class="badge warn">PENDING</span>')
  assert.equal(html(<StatusBadge status="SOMETHING_NEW" />), '<span class="badge warn">SOMETHING NEW</span>', 'underscores are not shown to people')
})

test('a missing status is a dash, not an empty badge', () => {
  assert.equal(html(<StatusBadge status={null} />), '<span class="badge">—</span>')
  assert.equal(html(<StatusBadge status={undefined} />), '<span class="badge">—</span>')
  assert.equal(html(<StatusBadge status="" />), '<span class="badge">—</span>')
})

test('error and confirmation text disappear when there is nothing to say', () => {
  assert.equal(html(<ErrorText error="" />), '')
  assert.equal(html(<ErrorText error={null} />), '')
  assert.equal(html(<OkText>{null}</OkText>), '')

  // Both carry a live-region role, so a screen reader announces them when they appear.
  assert.match(html(<ErrorText error="Card is closed" />), /role="alert"[^>]*>Card is closed</)
  assert.match(html(<OkText>Saved.</OkText>), /role="status"[^>]*>Saved\.</)
})

test('a key-value list drops what was never set and shows what was set to nothing', () => {
  const markup = html(<KeyValues rows={[['Amount', '12,00 €'], ['Requested', undefined], ['Envelope', null]]} />)

  // The distinction is the point: `undefined` means the row does not apply to this record,
  // `null` means it applies and is empty. A partial authorization has no requested amount to
  // show; an unallocated transaction has an envelope field that is genuinely blank.
  assert.ok(!markup.includes('Requested'), 'a row that does not apply is not rendered at all')
  assert.match(markup, /<dt>Envelope<\/dt><dd>—<\/dd>/, 'a row that applies but is empty shows a dash')
  assert.match(markup, /<dt>Amount<\/dt><dd>12,00 €<\/dd>/)
})

test('a section renders its heading, its hint and its children', () => {
  const markup = html(
    <Section title="Waiting for a second operator" hint="Nobody can approve their own request.">
      <p>body</p>
    </Section>,
  )
  assert.match(markup, /<h2[^>]*>Waiting for a second operator<\/h2>/)
  assert.match(markup, /Nobody can approve their own request\./)
  assert.match(markup, /<p>body<\/p>/)

  // No toolbar element at all when a section has no actions, rather than an empty one that
  // still takes up space.
  assert.ok(!html(<Section title="T">x</Section>).includes('toolbar'))
  assert.ok(html(<Section title="T" actions={<button type="button">Do</button>}>x</Section>).includes('toolbar'))
})
