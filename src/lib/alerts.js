/** Notification kinds grouped into the email alert types a cardholder can switch off. */
export const ALERT_GROUPS = {
  money: ['credit', 'recall', 'refund'],
  declines: ['decline', '3ds'],
  card: ['card', 'wallet'],
  disputes: ['dispute'],
  cash: ['cash'],
}
export const ALERT_GROUP_KEYS = Object.keys(ALERT_GROUPS)

export const alertGroupOf = (kind) => ALERT_GROUP_KEYS.find((group) => ALERT_GROUPS[group].includes(kind)) || null

/** Email for this kind? Alerts must be on and the kind's group not muted; ungrouped kinds always send. */
export function wantsEmail(prefs, kind) {
  if (!prefs?.emailAlerts) return false
  const group = alertGroupOf(kind)
  return !group || !(prefs.emailMuted || []).includes(group)
}
