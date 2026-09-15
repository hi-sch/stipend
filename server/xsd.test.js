import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createXsdValidator } from './xsd.js'
import { buildCamt029, buildPain002, parseCamt056, parsePain001, sampleCamt056, samplePain001 } from '../src/lib/pain001.js'

const xsd = createXsdValidator()

test('generated ISO 20022 messages validate against the official schemas', { skip: !xsd.available && 'xmllint not installed' }, () => {
  const pain001 = samplePain001({
    connectionName: 'Jobcenter',
    debtorName: 'BA',
    transactions: [
      { amountCents: 1000, endToEndId: 'E1', creditorIban: 'DE89370400440532013000', beneficiaryRef: 'REF-1', creditorName: 'Lena Vogt' },
      { amountCents: 250, endToEndId: 'E2' },
    ],
  })
  assert.deepEqual(xsd.validate(pain001, 'pain.001.001.09').errors, [])
  const parsed = parsePain001(pain001)
  const pain002 = buildPain002({ originalMsgId: parsed.msgId, originalPmtInfId: parsed.pmtInfId, statuses: [{ endToEndId: 'E1', status: 'ACCP' }, { endToEndId: 'E2', status: 'RJCT', reason: 'BE06', detail: 'Unknown' }] })
  assert.deepEqual(xsd.validate(pain002.xml, 'pain.002.001.10').errors, [])
  const camt056 = sampleCamt056({ endToEndId: 'E1', amountCents: 1000 })
  assert.deepEqual(xsd.validate(camt056, 'camt.056.001.08').errors, [])
  const camt029 = buildCamt029({ originalMsgId: parseCamt056(camt056).msgId, results: [{ originalEndToEndId: 'E1', status: 'CNCL' }, { originalEndToEndId: 'E9', status: 'RJCR', reason: 'NOOR' }] })
  assert.deepEqual(xsd.validate(camt029, 'camt.029.001.09').errors, [])
})

test('schema violations are reported with line numbers', { skip: !xsd.available && 'xmllint not installed' }, () => {
  const broken = samplePain001({ amountCents: 1000, endToEndId: 'E1' }).replace('<PmtMtd>TRF</PmtMtd>', '<PmtMtd>CASH</PmtMtd>')
  const result = xsd.validate(broken, 'pain.001.001.09')
  assert.equal(result.ok, false)
  assert.match(result.errors[0], /^line \d+: /)
})
