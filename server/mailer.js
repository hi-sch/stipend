import nodemailer from 'nodemailer'

const MAX_ATTEMPTS = 5
const MAX_AGE_MS = 24 * 60 * 60 * 1000

/** SMTP delivery for notification emails. Without SMTP_URL, mail stays queued in the outbox. */
export function createMailer(env = {}) {
  if (!env.SMTP_URL) return { configured: false, send: async () => { throw new Error('SMTP_URL is not configured') } }
  const transport = nodemailer.createTransport(env.SMTP_URL)
  const from = env.MAIL_FROM || 'Stipend <no-reply@stipend.local>'
  return {
    configured: true,
    send: ({ to, subject, text, from: sender }) => transport.sendMail({ from: sender || from, to, subject, text }),
  }
}

/** Sends queued outbox mail with exponential backoff. Returns counts for logging and tests. */
export async function deliverOutbox({ db, mailer, log, now = Date.now(), publicUrl, from }) {
  if (!mailer.configured) return { sent: 0, failed: 0 }
  const due = (db.read().emailOutbox || []).filter(
    (m) => (m.status || 'queued') === 'queued' && (!m.nextAttemptAt || Date.parse(m.nextAttemptAt) <= now),
  )
  let sent = 0
  let failed = 0
  for (const mail of due.slice(0, 20)) {
    if (now - Date.parse(mail.at) > MAX_AGE_MS) {
      patch(db, mail.id, { status: 'expired' })
      continue
    }
    try {
      await mailer.send({ to: mail.to, subject: mail.subject, text: [mail.body, publicUrl ? `\n${publicUrl}` : ''].join(''), from })
      patch(db, mail.id, { status: 'sent', sentAt: new Date(now).toISOString(), error: null })
      sent++
    } catch (err) {
      const attempts = (mail.attempts || 0) + 1
      patch(db, mail.id, {
        attempts,
        error: err.message,
        status: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued',
        nextAttemptAt: new Date(now + 2 ** attempts * 60000).toISOString(),
      })
      failed++
      log?.warn?.('email delivery failed', { to: mail.to, attempts, err })
    }
  }
  return { sent, failed }
}

function patch(db, id, fields) {
  db.mutate((s) => {
    const row = (s.emailOutbox || []).find((m) => m.id === id)
    if (row) Object.assign(row, fields)
  })
}
