export function samplePain001({
  connectionName,
  amountCents,
  endToEndId,
  debtorName,
  creditorName,
  purpose = 'SSBE',
}) {
  const amt = ((amountCents || 0) / 100).toFixed(2)
  const created = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${endToEndId || 'STPD-MSG-001'}</MsgId>
      <CreDtTm>${created}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <CtrlSum>${amt}</CtrlSum>
      <InitgPty><Nm>${escapeXml(debtorName || connectionName)}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>PMT-${endToEndId || '001'}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <BtchBookg>false</BtchBookg>
      <PmtTpInf>
        <SvcLvl><Cd>SEPA</Cd></SvcLvl>
        <CtgyPurp><Cd>${purpose}</Cd></CtgyPurp>
      </PmtTpInf>
      <ReqdExctnDt><Dt>${created.slice(0, 10)}</Dt></ReqdExctnDt>
      <Dbtr><Nm>${escapeXml(debtorName || connectionName)}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>DE02120300000000202051</IBAN></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><BIC>BYLADEM1001</BIC></FinInstnId></DbtrAgt>
      <CdtTrfTxInf>
        <PmtId>
          <EndToEndId>${endToEndId || 'E2E-STPD-001'}</EndToEndId>
        </PmtId>
        <Amt><InstdAmt Ccy="EUR">${amt}</InstdAmt></Amt>
        <Cdtr><Nm>${escapeXml(creditorName || 'Lena Vogt')}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>DE89370400440532013000</IBAN></Id></CdtrAcct>
        <Purp><Cd>${purpose}</Cd></Purp>
        <RmtInf><Ustrd>Stipend envelope credit — do not settle to IBAN</Ustrd></RmtInf>
      </CdtTrfTxInf>
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`
}

export function sampleJson({ connectionId, amountCents, endToEndId, purpose = 'SSBE' }) {
  return JSON.stringify(
    {
      connection_id: connectionId,
      beneficiary_ref: 'cardholder_lena_vogt',
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

function escapeXml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
