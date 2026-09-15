/**
 * Merchant categories whose whole amount is cash or cash-like. Card networks also flag cash on
 * any other merchant: processing code 01 (cash) and 09 (purchase with cashback) with the cashback
 * amount in DE54 (amount type 40). Lithic passes that on as `cash_amount`.
 */
export const CASH_MCCS = {
  6010: 'Manual cash disbursement (bank counter)',
  6011: 'ATM cash withdrawal',
  6050: 'Quasi-cash at a financial institution',
  6051: 'Quasi-cash at a merchant (foreign currency, money orders, travellers cheques, crypto)',
  4829: 'Money transfer and money orders',
  6529: 'Stored value load at a financial institution',
  6530: 'Stored value load at a merchant',
  6534: 'Money transfer at a financial institution',
  6540: 'Stored value and account funding',
}
export const CASH_MCC_CODES = Object.keys(CASH_MCCS)
export const ATM_MCC_CODES = ['6010', '6011']
/** Cash-like categories Lithic does not report in `cash_amount`; capped with an MCC-filtered velocity rule. */
export const QUASI_CASH_MCC_CODES = CASH_MCC_CODES.filter((code) => !ATM_MCC_CODES.includes(code))
export const CASH_PERIODS = ['DAY', 'WEEK', 'MONTH']

export const isCashMcc = (mcc) => CASH_MCC_CODES.includes(String(mcc))

/** Cash part of an authorization: all of it for cash categories, otherwise the network cashback amount. */
export function cashPartOf({ amountCents, mcc, cashAmount }) {
  const amount = Math.max(0, Math.round(Number(amountCents) || 0))
  if (isCashMcc(mcc)) return amount
  return Math.min(amount, Math.max(0, Math.round(Number(cashAmount) || 0)))
}
