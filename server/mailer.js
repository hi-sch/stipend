import nodemailer from 'nodemailer'

const MAX_ATTEMPTS = 5
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const BATCH = 20

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

/**
 * Send queued outbox mail with exponential backoff. Returns counts for logging and tests.
 *
 * Due mail is claimed with FOR UPDATE SKIP LOCKED before anything is sent, so several
 * replicas running this loop divide the work instead of each sending the same message.
 * The claim commits immediately and the SMTP call happens outside any transaction: holding
 * row locks open across a network round trip is how a slow mail server becomes a database
 * problem.
 */
export async function deliverOutbox({ db, mailer, log, now = Date.now(), publicUrl, from }) {
  if (!mailer.configured) return { sent: 0, failed: 0 }

  const claimed = await db.tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE email_outbox
          SET status = 'SENDING', attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM email_outbox
           WHERE status = 'QUEUED'
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           ORDER BY created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [BATCH],
    )
    return rows
  })

  let sent = 0
  let failed = 0

  for (const mail of claimed) {
    // Mail nobody could deliver for a day is not going to start working now.
    if (now - Date.parse(mail.created_at) > MAX_AGE_MS) {
      await db.query(`UPDATE email_outbox SET status = 'EXPIRED' WHERE id = $1`, [mail.id])
      continue
    }

    try {
      await mailer.send({
        to: mail.to_address,
        subject: mail.subject,
        text: [mail.body, publicUrl ? `\n${publicUrl}` : ''].join(''),
        from,
      })
      await db.query(`UPDATE email_outbox SET status = 'SENT', sent_at = $2, last_error = NULL WHERE id = $1`, [mail.id, new Date(now).toISOString()])
      sent += 1
    } catch (err) {
      const attempts = mail.attempts
      await db.query(
        `UPDATE email_outbox
            SET status = $2, last_error = $3, next_attempt_at = $4
          WHERE id = $1`,
        [
          mail.id,
          attempts >= MAX_ATTEMPTS ? 'FAILED' : 'QUEUED',
          err.message,
          new Date(now + 2 ** attempts * 60000).toISOString(),
        ],
      )
      failed += 1
      log?.warn?.('email delivery failed', { to: mail.to_address, attempts, err })
    }
  }

  return { sent, failed }
}

/**
 * Return mail that was claimed but never resolved, which is what a pod being killed
 * mid-send leaves behind. Called on start so those messages are retried rather than
 * sitting in SENDING for ever.
 */
export async function requeueStuck({ db, olderThanMs = 5 * 60 * 1000 } = {}) {
  const { rows } = await db.query(
    `UPDATE email_outbox
        SET status = 'QUEUED'
      WHERE status = 'SENDING'
        AND created_at < now() - ($1 || ' milliseconds')::interval
      RETURNING id`,
    [String(olderThanMs)],
  )
  return rows.map((r) => r.id)
}
