import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCamt029,
  buildPain002,
  isValidIban,
  makeIban,
  parseCamt056,
  parsePain001,
  sampleCamt056,
  samplePain001,
} from './pain001.js'

test('parses amount and end-to-end id from sample pain.001', () => {
  const xml = samplePain001({
    connectionName: 'Jobcenter',
    amountCents: 12345,
    endToEndId: 'E2E-99',
    debtorName: 'BA',
    purpose: 'SSBE',
  })
  const parsed = parsePain001(xml)
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.amountCents, 12345)
  assert.equal(parsed.endToEndId, 'E2E-99')
  assert.equal(parsed.purpose, 'SSBE')
  assert.equal(parsed.currency, 'EUR')
  assert.equal(parsed.txCount, 1)
})

test('parses batch files with beneficiary identifiers', () => {
  const xml = samplePain001({
    connectionName: 'CAF',
    transactions: [
      { amountCents: 1000, endToEndId: 'A1', beneficiaryRef: 'REF-1', creditorIban: 'DE89 3704 0044 0532 0130 00' },
      { amountCents: 2550, endToEndId: 'A2', beneficiaryRef: 'REF-2' },
    ],
  })
  const parsed = parsePain001(xml)
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.payments.length, 2)
  assert.equal(parsed.payments[0].beneficiaryRef, 'REF-1')
  assert.equal(parsed.payments[0].creditorIban, 'DE89370400440532013000')
  assert.equal(parsed.payments[1].amountCents, 2550)
})

test('flags structural problems', () => {
  const xml = samplePain001({ amountCents: 1000, endToEndId: 'A1' }).replace('<NbOfTxs>1</NbOfTxs>', '<NbOfTxs>3</NbOfTxs>').replace(/(<InstdAmt Ccy="EUR">)10\.00/, '$110.005')
  const parsed = parsePain001(xml)
  assert.ok(parsed.errors.some((e) => e.includes('NbOfTxs')))
  assert.ok(parsed.payments[0].errors.length)
})

test('escapes markup in identifiers', () => {
  const xml = samplePain001({ connectionName: 'A & B', amountCents: 100, endToEndId: 'E2E<1>' })
  assert.match(xml, /<EndToEndId>E2E&lt;1&gt;<\/EndToEndId>/)
  assert.equal(parsePain001(xml).endToEndId, 'E2E<1>')
})

test('pain.002 group status reflects partial rejection', () => {
  const report = buildPain002({
    originalMsgId: 'M1',
    statuses: [
      { endToEndId: 'A1', status: 'ACCP' },
      { endToEndId: 'A2', status: 'RJCT', reason: 'BE06', detail: 'Unknown beneficiary' },
    ],
  })
  assert.equal(report.groupStatus, 'PART')
  assert.match(report.xml, /<GrpSts>PART<\/GrpSts>/)
  assert.match(report.xml, /<Cd>BE06<\/Cd>/)
})

test('camt.056 round trip and camt.029', () => {
  const parsed = parseCamt056(sampleCamt056({ endToEndId: 'E2E-7', amountCents: 5000, reason: 'DUPL' }))
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.cases[0].originalEndToEndId, 'E2E-7')
  assert.equal(parsed.cases[0].amountCents, 5000)
  assert.equal(parsed.cases[0].reason, 'DUPL')
  assert.match(buildCamt029({ originalMsgId: parsed.msgId, results: [{ originalEndToEndId: 'E2E-7', status: 'CNCL' }] }), /CNCL/)
})

test('IBAN helpers', () => {
  assert.equal(isValidIban('DE89 3704 0044 0532 0130 00'), true)
  assert.equal(isValidIban('DE00370400440532013000'), false)
  const iban = makeIban('DE', '500105170000012345')
  assert.equal(isValidIban(iban), true)
})
