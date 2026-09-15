import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * ISO 20022 schema validation through libxml2's xmllint (network disabled, no entity expansion).
 * When xmllint is missing, validation is skipped and the structural checks in pain001.js still apply.
 */
export function createXsdValidator({ dir = join(here, 'xsd'), bin = 'xmllint', log } = {}) {
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  const available = !probe.error && /libxml/i.test(`${probe.stdout}${probe.stderr}`)
  if (!available) log?.warn?.('xmllint not found; ISO 20022 XSD validation disabled')
  return {
    available,
    validate(xml, schema) {
      const file = join(dir, `${schema}.xsd`)
      if (!available || !existsSync(file)) return { ok: true, skipped: true, errors: [] }
      const result = spawnSync(bin, ['--noout', '--nonet', '--schema', file, '-'], {
        input: String(xml),
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      })
      if (result.error) return { ok: false, errors: [`Validator failed: ${result.error.message}`] }
      const errors = String(result.stderr || '')
        .split('\n')
        .filter((line) => /error/i.test(line) && !/fails to validate|validates$/.test(line))
        .map((line) => line.replace(/^-:(\d+):\s*/, 'line $1: ').replace(/\{urn:iso:std:iso:20022:tech:xsd:[^}]+\}/g, '').replace(/Schemas validity error : /, ''))
        .slice(0, 10)
      return { ok: result.status === 0, errors: result.status === 0 ? [] : errors.length ? errors : ['Document does not match the schema'] }
    },
  }
}
