// ISO 20022 helpers for the credit hook: pain.001 in, pain.002 / camt.029 out, camt.056 recalls in.
// Structural validation only (no XSD): required elements, counts, control sum, amounts, currency.

export function samplePain001({
  connectionName,
  amountCents,
  endToEndId,
  debtorName,
  creditorName,
  creditorIban,
  beneficiaryRef,
  purpose = 'SSBE',
  transactions,
}) {
  const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const txs = transactions?.length
    ? transactions
    : [{ amountCents, endToEndId: endToEndId || 'E2E-STPD-001', creditorName, creditorIban, beneficiaryRef }]
  const total = txs.reduce((s, t) => s + (t.amountCents || 0), 0)
  const msgId = escapeXml(txs[0].endToEndId ? `MSG-${txs[0].endToEndId}` : 'STPD-MSG-001').slice(0, 35)
  const debtor = escapeXml(debtorName || connectionName || 'Paying agency')
  const txXml = txs
    .map(
      (t) => `      <CdtTrfTxInf>
        <PmtId>
          <EndToEndId>${escapeXml(t.endToEndId)}</EndToEndId>
        </PmtId>
        <Amt><InstdAmt Ccy="EUR">${money(t.amountCents)}</InstdAmt></Amt>
        <Cdtr>
          <Nm>${escapeXml(t.creditorName || 'Lena Vogt')}</Nm>${
            t.beneficiaryRef
              ? `
          <Id><PrvtId><Othr><Id>${escapeXml(t.beneficiaryRef)}</Id></Othr></PrvtId></Id>`
              : ''
          }
        </Cdtr>
        <CdtrAcct><Id><IBAN>${escapeXml(t.creditorIban || 'DE89370400440532013000')}</IBAN></Id></CdtrAcct>
        <Purp><Cd>${escapeXml(t.purpose || purpose)}</Cd></Purp>
        <RmtInf><Ustrd>${escapeXml(t.remittance || 'Stipend envelope credit')}</Ustrd></RmtInf>
      </CdtTrfTxInf>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${msgId}</MsgId>
      <CreDtTm>${created}</CreDtTm>
      <NbOfTxs>${txs.length}</NbOfTxs>
      <CtrlSum>${money(total)}</CtrlSum>
      <InitgPty><Nm>${debtor}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>PMT-${msgId}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <BtchBookg>false</BtchBookg>
      <NbOfTxs>${txs.length}</NbOfTxs>
      <CtrlSum>${money(total)}</CtrlSum>
      <PmtTpInf>
        <SvcLvl><Cd>SEPA</Cd></SvcLvl>
        <CtgyPurp><Cd>${escapeXml(purpose)}</Cd></CtgyPurp>
      </PmtTpInf>
      <ReqdExctnDt><Dt>${created.slice(0, 10)}</Dt></ReqdExctnDt>
      <Dbtr><Nm>${debtor}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>DE02120300000000202051</IBAN></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><BICFI>BYLADEM1001</BICFI></FinInstnId></DbtrAgt>
${txXml}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`
}

export function sampleJson({ connectionId, amountCents, endToEndId, purpose = 'SSBE', beneficiaryRef = 'DE-BA-100042', iban }) {
  return JSON.stringify(
    {
      connection_id: connectionId,
      beneficiary_ref: beneficiaryRef,
      ...(iban ? { creditor_iban: iban } : {}),
      amount: amountCents,
      currency: 'EUR',
      end_to_end_id: endToEndId,
      purpose_code: purpose,
      remittance: 'Restricted envelope credit',
    },
    null,
    2,
  )
}

export function parsePain001(xml) {
  const text = String(xml || '')
  const errors = []
  if (!findAll(text, 'CstmrCdtTrfInitn').length) errors.push('Missing CstmrCdtTrfInitn (not a pain.001 document)')
  const header = first(text, 'GrpHdr') || ''
  const msgId = value(header, 'MsgId')
  const pmtInfId = value(first(text, 'PmtInf') || '', 'PmtInfId')
  if (!msgId) errors.push('GrpHdr/MsgId is required')
  const nbOfTxs = Number(value(header, 'NbOfTxs') || NaN)
  const ctrlSumRaw = value(header, 'CtrlSum')
  const payments = findAll(text, 'CdtTrfTxInf').map((tx, index) => {
    const txErrors = []
    const amt = tx.match(/<(?:\w+:)?InstdAmt([^>]*)>\s*([^<\s]+)\s*</)
    const rawAmount = amt?.[2] || ''
    const currency = amt?.[1].match(/Ccy="([A-Z]{3})"/)?.[1] || ''
    const endToEndId = value(first(tx, 'PmtId') || '', 'EndToEndId')
    if (!endToEndId) txErrors.push('EndToEndId is required')
    else if (endToEndId.length > 35) txErrors.push('EndToEndId exceeds 35 characters')
    if (!/^\d{1,15}(\.\d{1,2})?$/.test(rawAmount)) txErrors.push(`InstdAmt "${rawAmount}" is not a valid amount`)
    if (!currency) txErrors.push('InstdAmt/@Ccy is required')
    const creditor = first(tx, 'Cdtr') || ''
    const amountCents = /^\d{1,15}(\.\d{1,2})?$/.test(rawAmount) ? Math.round(Number(rawAmount) * 100) : 0
    if (amountCents <= 0 && !txErrors.length) txErrors.push('InstdAmt must be positive')
    return {
      index,
      endToEndId,
      amountCents,
      currency,
      creditorName: value(creditor, 'Nm'),
      beneficiaryRef: value(first(creditor, 'Othr') || '', 'Id'),
      creditorIban: (value(first(tx, 'CdtrAcct') || '', 'IBAN') || '').replace(/\s/g, '').toUpperCase(),
      purpose: value(first(tx, 'Purp') || '', 'Cd'),
      remittance: value(first(tx, 'RmtInf') || '', 'Ustrd'),
      errors: txErrors,
    }
  })
  if (!payments.length) errors.push('No CdtTrfTxInf found')
  if (Number.isFinite(nbOfTxs) && nbOfTxs !== payments.length) {
    errors.push(`GrpHdr/NbOfTxs is ${nbOfTxs} but the file contains ${payments.length} transactions`)
  }
  if (ctrlSumRaw) {
    const sum = payments.reduce((s, p) => s + p.amountCents, 0)
    if (Math.round(Number(ctrlSumRaw) * 100) !== sum) errors.push(`GrpHdr/CtrlSum ${ctrlSumRaw} does not match the transaction total`)
  }
  const firstTx = payments[0] || {}
  return {
    msgId,
    pmtInfId,
    createdAt: value(header, 'CreDtTm'),
    initiatingParty: value(first(header, 'InitgPty') || '', 'Nm'),
    nbOfTxs: payments.length,
    payments,
    errors,
    // Single-transaction shorthands.
    amountCents: firstTx.amountCents || 0,
    endToEndId: firstTx.endToEndId || '',
    remittance: firstTx.remittance || '',
    purpose: firstTx.purpose || 'SSBE',
    currency: firstTx.currency || '',
    txCount: payments.length,
  }
}

const STIPEND_BIC = 'STPDDEB1XXX'

export function buildPain002({ originalMsgId, originalPmtInfId, statuses, msgId = `STPD-${Date.now()}`, created = new Date() }) {
  const rejected = statuses.filter((s) => s.status === 'RJCT').length
  const groupStatus = rejected === 0 ? 'ACCP' : rejected === statuses.length ? 'RJCT' : 'PART'
  const rows = statuses
    .map(
      (s) => `      <TxInfAndSts>
        <OrgnlEndToEndId>${escapeXml(s.endToEndId || 'NOTPROVIDED')}</OrgnlEndToEndId>
        <TxSts>${s.status}</TxSts>${
          s.reason
            ? `
        <StsRsnInf><Rsn><Cd>${escapeXml(s.reason)}</Cd></Rsn>${s.detail ? `<AddtlInf>${escapeXml(s.detail).slice(0, 105)}</AddtlInf>` : ''}</StsRsnInf>`
            : ''
        }
      </TxInfAndSts>`,
    )
    .join('\n')
  return {
    groupStatus,
    xml: `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.10">
  <CstmrPmtStsRpt>
    <GrpHdr>
      <MsgId>${escapeXml(msgId)}</MsgId>
      <CreDtTm>${created.toISOString().replace(/\.\d+Z$/, 'Z')}</CreDtTm>
      <InitgPty><Nm>Stipend</Nm></InitgPty>
    </GrpHdr>
    <OrgnlGrpInfAndSts>
      <OrgnlMsgId>${escapeXml(originalMsgId || 'NOTPROVIDED')}</OrgnlMsgId>
      <OrgnlMsgNmId>pain.001.001.09</OrgnlMsgNmId>
      <OrgnlNbOfTxs>${statuses.length}</OrgnlNbOfTxs>
      <GrpSts>${groupStatus}</GrpSts>
    </OrgnlGrpInfAndSts>
    <OrgnlPmtInfAndSts>
      <OrgnlPmtInfId>${escapeXml(originalPmtInfId || originalMsgId || 'NOTPROVIDED')}</OrgnlPmtInfId>
${rows}
    </OrgnlPmtInfAndSts>
  </CstmrPmtStsRpt>
</Document>`,
  }
}

export function parseCamt056(xml) {
  const text = String(xml || '')
  const errors = []
  if (!findAll(text, 'FIToFIPmtCxlReq').length) errors.push('Missing FIToFIPmtCxlReq (not a camt.056 document)')
  const assignment = first(text, 'Assgnmt') || ''
  const msgId = (assignment.match(/^\s*<(?:\w+:)?Id>([^<]*)</) || [])[1] || value(first(text, 'GrpHdr') || '', 'MsgId')
  const cases = findAll(text, 'TxInf').map((tx) => {
    const amt = tx.match(/<(?:\w+:)?(?:OrgnlIntrBkSttlmAmt|OrgnlInstdAmt)[^>]*>\s*([0-9.]+)\s*</)?.[1]
    return {
      originalEndToEndId: value(tx, 'OrgnlEndToEndId'),
      originalMsgId: value(tx, 'OrgnlMsgId'),
      reason: value(first(tx, 'CxlRsnInf') || '', 'Cd') || 'CUST',
      amountCents: amt ? Math.round(Number(amt) * 100) : null,
    }
  })
  if (!cases.length) errors.push('No TxInf found')
  cases.forEach((c, i) => {
    if (!c.originalEndToEndId) errors.push(`TxInf ${i + 1}: OrgnlEndToEndId is required`)
  })
  return { msgId, cases, errors }
}

export function sampleCamt056({ endToEndId, amountCents, reason = 'DUPL', assigner = 'BYLADEM1001' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.056.001.08">
  <FIToFIPmtCxlReq>
    <Assgnmt>
      <Id>${escapeXml(`RCL-${endToEndId}`).slice(0, 35)}</Id>
      <Assgnr><Agt><FinInstnId><BICFI>${escapeXml(assigner)}</BICFI></FinInstnId></Agt></Assgnr>
      <Assgne><Agt><FinInstnId><BICFI>${STIPEND_BIC}</BICFI></FinInstnId></Agt></Assgne>
      <CreDtTm>${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</CreDtTm>
    </Assgnmt>
    <Undrlyg>
      <TxInf>
        <OrgnlEndToEndId>${escapeXml(endToEndId)}</OrgnlEndToEndId>
        <OrgnlIntrBkSttlmAmt Ccy="EUR">${money(amountCents)}</OrgnlIntrBkSttlmAmt>
        <CxlRsnInf><Rsn><Cd>${escapeXml(reason)}</Cd></Rsn></CxlRsnInf>
      </TxInf>
    </Undrlyg>
  </FIToFIPmtCxlReq>
</Document>`
}

// Stipend reports CNCL/PDCR/RJCR per recall; camt.029 transaction status uses ACCR for an accepted cancellation.
const TX_CANCELLATION_STATUS = { CNCL: 'ACCR', PDCR: 'PDCR', RJCR: 'RJCR' }

export function buildCamt029({ originalMsgId, results, msgId = `STPD-RSLN-${Date.now()}`, assignee = 'BYLADEM1001' }) {
  const statuses = results.map((r) => r.status)
  const overall = statuses.every((x) => x === 'CNCL') ? 'CNCL' : statuses.every((x) => x === 'RJCR') ? 'RJCR' : 'PDCR'
  const rows = results
    .map(
      (r, i) => `        <TxInfAndSts>
          <CxlStsId>${escapeXml(`${msgId}-${i + 1}`).slice(0, 35)}</CxlStsId>
          <OrgnlEndToEndId>${escapeXml(r.originalEndToEndId || 'NOTPROVIDED')}</OrgnlEndToEndId>
          <TxCxlSts>${TX_CANCELLATION_STATUS[r.status] || escapeXml(r.status)}</TxCxlSts>${
            r.reason
              ? `
          <CxlStsRsnInf><Rsn><Cd>${escapeXml(r.reason)}</Cd></Rsn>${r.detail ? `<AddtlInf>${escapeXml(r.detail).slice(0, 105)}</AddtlInf>` : ''}</CxlStsRsnInf>`
              : ''
          }
        </TxInfAndSts>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.029.001.09">
  <RsltnOfInvstgtn>
    <Assgnmt>
      <Id>${escapeXml(msgId).slice(0, 35)}</Id>
      <Assgnr><Agt><FinInstnId><BICFI>${STIPEND_BIC}</BICFI></FinInstnId></Agt></Assgnr>
      <Assgne><Agt><FinInstnId><BICFI>${escapeXml(assignee)}</BICFI></FinInstnId></Agt></Assgne>
      <CreDtTm>${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</CreDtTm>
    </Assgnmt>
    <Sts><Conf>${overall}</Conf></Sts>
    <CxlDtls>
      <OrgnlGrpInfAndSts>
        <OrgnlMsgId>${escapeXml(originalMsgId || 'NOTPROVIDED')}</OrgnlMsgId>
        <OrgnlMsgNmId>camt.056.001.08</OrgnlMsgNmId>
      </OrgnlGrpInfAndSts>
${rows}
    </CxlDtls>
  </RsltnOfInvstgtn>
</Document>`
}

export function isValidIban(iban) {
  const s = String(iban || '').replace(/\s/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false
  return mod97(s.slice(4) + s.slice(0, 4)) === 1
}

export function makeIban(country, bban) {
  const base = `${bban}${country}00`
  const check = String(98 - mod97(base)).padStart(2, '0')
  return `${country}${check}${bban}`
}

function mod97(s) {
  let rem = 0
  for (const ch of s) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of v) rem = (rem * 10 + Number(d)) % 97
  }
  return rem
}

function findAll(text, name) {
  const re = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'g')
  return [...text.matchAll(re)].map((m) => m[1])
}

function first(text, name) {
  return findAll(text, name)[0]
}

function value(text, name) {
  const raw = first(text || '', name)
  return raw == null ? '' : unescapeXml(raw.trim())
}

function money(cents) {
  return ((cents || 0) / 100).toFixed(2)
}

function escapeXml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function unescapeXml(s) {
  return s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')
}
