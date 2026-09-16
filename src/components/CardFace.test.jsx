import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../i18n/I18n.jsx'
import CardFace from './CardFace.jsx'

/**
 * The plastic.
 *
 * Stipend never handles a card number: the real values arrive inside Lithic's embed, which
 * this component overlays on its own masked text so the two share font, size and position.
 * That makes the masking worth holding down — a regression here does not break a layout, it
 * puts a card number on a screen.
 */
const render = (el) => renderToStaticMarkup(<I18nProvider>{el}</I18nProvider>)
const card = (over = {}) => ({ state: 'OPEN', lastFour: '1538', network: 'Visa', ...over })

test('the card shows the last four and nothing more', () => {
  const markup = render(<CardFace card={card()} holder="Lena Vogt" />)
  assert.match(markup, /\*\*\*\* \*\*\*\* \*\*\*\* 1538/)
  assert.match(markup, /\*\*\*/, 'the CVC is masked too')
  assert.match(markup, /LENA VOGT/, 'the name is set in capitals as it is on the plastic')
})

test('asking for a reveal without the embed reveals nothing', () => {
  // shown is Boolean(slots) && revealed. Without the embed there is nothing to show, and the
  // component must not decide otherwise: this is the branch that would put a PAN on screen.
  const markup = render(<CardFace card={card()} holder="Lena Vogt" revealed />)
  assert.match(markup, /\*\*\*\* \*\*\*\* \*\*\*\* 1538/)
  assert.match(markup, /aria-hidden="false"/, 'the mask is what a screen reader reads')
})

test('with the embed in place the mask steps aside', () => {
  const slots = { pan: <i data-slot="pan" />, cvv: <i data-slot="cvv" />, expMonth: <i data-slot="m" />, expYear: <i data-slot="y" /> }
  const hidden = render(<CardFace card={card()} holder="Lena Vogt" slots={slots} />)
  assert.match(hidden, /aria-hidden="false"/, 'not revealed yet, so the mask still speaks')
  assert.match(hidden, /data-slot="pan"/, 'the embed is mounted either way')

  const shown = render(<CardFace card={card()} holder="Lena Vogt" slots={slots} revealed />)
  assert.match(shown, /aria-hidden="true"/, 'revealed: the real value is read, not the mask')
})

test('a card with no number yet is bullets, not the word undefined', () => {
  const markup = render(<CardFace card={{ state: 'OPEN' }} holder="Lena Vogt" />)
  assert.ok(!markup.includes('undefined'))
  assert.match(markup, /••••/)
})

test('a frozen card says so and looks different', () => {
  const frozen = render(<CardFace card={card({ state: 'PAUSED' })} holder="Lena Vogt" />)
  assert.match(frozen, /is-paused/)
  assert.match(frozen, /frozen|blocked|Frozen/i, 'and explains why purchases will decline')

  const open = render(<CardFace card={card()} holder="Lena Vogt" />)
  assert.ok(!open.includes('is-paused'), 'an open card carries neither')
})

test('the network mark follows the card', () => {
  assert.match(render(<CardFace card={card({ network: 'Visa' })} holder="L" />), /aria-label="Visa"/)
  assert.match(render(<CardFace card={card({ network: 'Mastercard' })} holder="L" />), /aria-label="Mastercard"/)
  // Unknown networks fall back to Visa rather than rendering no mark at all.
  assert.match(render(<CardFace card={card({ network: undefined })} holder="L" />), /aria-label="Visa"/)
})
