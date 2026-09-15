import { codesForGroups } from './mccs.js'

export const COUNTRIES = [
  { code: 'DE', name: 'Germany', adjective: 'German', alpha3: 'DEU' },
  { code: 'FR', name: 'France', adjective: 'French', alpha3: 'FRA' },
  { code: 'NL', name: 'Netherlands', adjective: 'Dutch', alpha3: 'NLD' },
  { code: 'ES', name: 'Spain', adjective: 'Spanish', alpha3: 'ESP' },
  { code: 'IT', name: 'Italy', adjective: 'Italian', alpha3: 'ITA' },
  { code: 'PL', name: 'Poland', adjective: 'Polish', alpha3: 'POL' },
  { code: 'SE', name: 'Sweden', adjective: 'Swedish', alpha3: 'SWE' },
  { code: 'FI', name: 'Finland', adjective: 'Finnish', alpha3: 'FIN' },
  { code: 'EU', name: 'EU-wide', adjective: 'European', alpha3: null },
]

export const ALPHA3 = {
  DE: 'DEU',
  FR: 'FRA',
  NL: 'NLD',
  ES: 'ESP',
  IT: 'ITA',
  PL: 'POL',
  SE: 'SWE',
  FI: 'FIN',
  AT: 'AUT',
  BE: 'BEL',
  PT: 'PRT',
  IE: 'IRL',
  DK: 'DNK',
  LU: 'LUX',
  CZ: 'CZE',
  GB: 'GBR',
  CH: 'CHE',
  NO: 'NOR',
}

export const SPEND_COUNTRIES = [
  { code: 'DEU', name: 'Germany' },
  { code: 'FRA', name: 'France' },
  { code: 'NLD', name: 'Netherlands' },
  { code: 'ESP', name: 'Spain' },
  { code: 'ITA', name: 'Italy' },
  { code: 'POL', name: 'Poland' },
  { code: 'SWE', name: 'Sweden' },
  { code: 'FIN', name: 'Finland' },
  { code: 'AUT', name: 'Austria' },
  { code: 'BEL', name: 'Belgium' },
  { code: 'PRT', name: 'Portugal' },
  { code: 'IRL', name: 'Ireland' },
  { code: 'DNK', name: 'Denmark' },
  { code: 'LUX', name: 'Luxembourg' },
  { code: 'CZE', name: 'Czechia' },
  { code: 'GBR', name: 'United Kingdom' },
  { code: 'CHE', name: 'Switzerland' },
  { code: 'NOR', name: 'Norway' },
]

export function toAlpha3(code) {
  if (!code) return ''
  const upper = code.toUpperCase()
  if (upper.length === 3) return upper
  return ALPHA3[upper] || ''
}

export function defaultCountriesFor(country) {
  if (country === 'EU') return ['DEU', 'FRA', 'NLD', 'ESP', 'ITA', 'POL', 'SWE', 'FIN']
  const a = toAlpha3(country)
  return a ? [a] : []
}

export const PROTOCOLS = [
  {
    id: 'pain001',
    label: 'ISO 20022 pain.001',
    hint: 'CustomerCreditTransferInitiation XML — what SAP PSCD, CGI_XML_CT and almost every EU treasury already emit.',
  },
  {
    id: 'ebics',
    label: 'EBICS',
    hint: 'Same pain.001 payload, delivered over EBICS (SozialBank, Bank-Verlag, French and German public administrations).',
  },
  {
    id: 'json',
    label: 'REST JSON hook',
    hint: 'Modern overlay for agencies that can POST JSON instead of a payment file.',
  },
]

export const AGENCIES = [
  {
    id: 'de-jobcenter',
    country: 'DE',
    name: 'Jobcenter Bürgergeld',
    agency: 'Bundesagentur für Arbeit / Jobcenter',
    system: 'SAP PSCD · EBICS',
    purpose: 'SSBE',
    preset: 'living',
    mccs: codesForGroups(['food', 'energy', 'household', 'clothing']),
  },
  {
    id: 'de-wohngeld',
    country: 'DE',
    name: 'Wohngeldstelle',
    agency: 'Municipal housing benefit office',
    system: 'SAP FI-CA · pain.001',
    purpose: 'SSBE',
    preset: 'housing',
    mccs: codesForGroups(['housing', 'energy']),
  },
  {
    id: 'de-gkv',
    country: 'DE',
    name: 'GKV Zuzahlung',
    agency: 'Gesetzliche Krankenkasse',
    system: 'pain.001 · EBICS',
    purpose: 'SSBE',
    preset: 'health',
    mccs: codesForGroups(['health']),
  },
  {
    id: 'de-bafog',
    country: 'DE',
    name: 'BAföG Amt',
    agency: 'Studentenwerk / BAföG office',
    system: 'pain.001',
    purpose: 'SSBE',
    preset: 'family',
    mccs: codesForGroups(['food', 'education', 'transport']),
  },
  {
    id: 'fr-caf',
    country: 'FR',
    name: 'CAF Allocations familiales',
    agency: 'Caisse d’allocations familiales',
    system: 'Chorus / pain.001',
    purpose: 'SSBE',
    preset: 'family',
    mccs: codesForGroups(['food', 'childcare', 'education', 'housing']),
  },
  {
    id: 'fr-travail',
    country: 'FR',
    name: 'France Travail',
    agency: 'France Travail',
    system: 'pain.001',
    purpose: 'SSBE',
    preset: 'living',
    mccs: codesForGroups(['food', 'energy', 'transport']),
  },
  {
    id: 'fr-ameli',
    country: 'FR',
    name: 'Assurance Maladie',
    agency: 'CNAM / CPAM',
    system: 'pain.001',
    purpose: 'SSBE',
    preset: 'health',
    mccs: codesForGroups(['health']),
  },
  {
    id: 'nl-uwv',
    country: 'NL',
    name: 'UWV Uitkering',
    agency: 'Uitvoeringsinstituut Werknemersverzekeringen',
    system: 'Digipoort · pain.001',
    purpose: 'SSBE',
    preset: 'living',
    mccs: codesForGroups(['food', 'energy', 'household']),
  },
  {
    id: 'nl-toeslagen',
    country: 'NL',
    name: 'Toeslagen',
    agency: 'Belastingdienst Toeslagen',
    system: 'pain.001',
    purpose: 'SSBE',
    preset: 'housing',
    mccs: codesForGroups(['housing', 'energy', 'childcare']),
  },
  {
    id: 'nl-svb',
    country: 'NL',
    name: 'SVB AOW / kinderbijslag',
    agency: 'Sociale Verzekeringsbank',
    system: 'pain.001',
    purpose: 'SSBE',
    preset: 'family',
    mccs: codesForGroups(['food', 'childcare']),
  },
  {
    id: 'es-sepe',
    country: 'ES',
    name: 'SEPE Prestación',
    agency: 'Servicio Público de Empleo Estatal',
    system: 'pain.001',
    purpose: 'SSBE',
    preset: 'living',
    mccs: codesForGroups(['food', 'energy', 'household']),
  },
  {
    id: 'es-inss',
    country: 'ES',
    name: 'INSS Pensiones',
    agency: 'Instituto Nacional de la Seguridad Social',
    system: 'pain.001',
    purpose: 'SSBE',
    preset: 'living',
    mccs: codesForGroups(['food', 'health', 'energy']),
  },
  {
    id: 'it-inps',
    country: 'IT',
    name: 'INPS Prestazioni',
    agency: 'Istituto Nazionale della Previdenza Sociale',
    system: 'pain.001',
    purpose: 'SSBE',
    preset: 'living',
    mccs: codesForGroups(['food', 'energy', 'health']),
  },
  {
    id: 'pl-zus',
    country: 'PL',
    name: 'ZUS Świadczenia',
    agency: 'Zakład Ubezpieczeń Społecznych',
    system: 'Elixir / pain.001',
    purpose: 'SSBE',
    preset: 'living',
    mccs: codesForGroups(['food', 'energy', 'health']),
  },
  {
    id: 'se-fk',
    country: 'SE',
    name: 'Försäkringskassan',
    agency: 'Försäkringskassan',
    system: 'Bankgirot · pain.001',
    purpose: 'SSBE',
    preset: 'family',
    mccs: codesForGroups(['food', 'childcare', 'health']),
  },
  {
    id: 'fi-kela',
    country: 'FI',
    name: 'Kela',
    agency: 'Kansaneläkelaitos',
    system: 'pain.001',
    purpose: 'SSBE',
    preset: 'living',
    mccs: codesForGroups(['food', 'health', 'energy']),
  },
  {
    id: 'eu-cap',
    country: 'EU',
    name: 'CAP paying agency',
    agency: 'National CAP paying agency (IACS)',
    system: 'ISO 20022 · pain.001',
    purpose: 'GOVT',
    preset: 'farm',
    mccs: [...codesForGroups(['agri']), '5983'],
  },
]

export function countryName(code) {
  return COUNTRIES.find((c) => c.code === code)?.name ?? code
}
