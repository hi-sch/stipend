export const MCC_GROUPS = [
  {
    id: 'food',
    label: 'Groceries & food',
    color: '#7C6CF0',
    codes: [
      ['5411', 'Grocery stores, supermarkets'],
      ['5422', 'Freezer / meat provisioners'],
      ['5441', 'Candy, nut, confectionery'],
      ['5451', 'Dairy product stores'],
      ['5462', 'Bakeries'],
      ['5499', 'Convenience and specialty food'],
      ['5812', 'Eating places, restaurants'],
      ['5814', 'Fast food restaurants'],
    ],
  },
  {
    id: 'housing',
    label: 'Housing & rent',
    color: '#C9894A',
    codes: [
      ['6513', 'Real estate agents and managers — rentals'],
      ['1520', 'General contractors — residential'],
      ['1771', 'Concrete work contractors'],
      ['1711', 'Heating, plumbing, air conditioning'],
      ['1731', 'Electrical contractors'],
      ['1761', 'Roofing, siding, sheet metal'],
      ['1799', 'Special trade contractors'],
      ['5211', 'Building materials, lumber'],
      ['5200', 'Home supply warehouse'],
    ],
  },
  {
    id: 'energy',
    label: 'Energy & utilities',
    color: '#E0A21A',
    codes: [
      ['4900', 'Utilities — electric, gas, water, sanitary'],
      ['5983', 'Fuel dealers — coal, oil, liquefied petroleum'],
    ],
  },
  {
    id: 'health',
    label: 'Health & pharmacy',
    color: '#2F9E8A',
    codes: [
      ['5912', 'Drug stores, pharmacies'],
      ['4119', 'Ambulance services'],
      ['8011', 'Doctors, physicians'],
      ['8021', 'Dentists, orthodontists'],
      ['8031', 'Osteopaths'],
      ['8041', 'Chiropractors'],
      ['8042', 'Optometrists, ophthalmologists'],
      ['8043', 'Opticians, optical goods'],
      ['8049', 'Podiatrists, chiropodists'],
      ['8050', 'Nursing and personal care facilities'],
      ['8062', 'Hospitals'],
      ['8071', 'Medical and dental laboratories'],
      ['8099', 'Medical services — not elsewhere classified'],
    ],
  },
  {
    id: 'transport',
    label: 'Transport',
    color: '#3D7EDB',
    codes: [
      ['4111', 'Local and suburban commuter transport'],
      ['4112', 'Passenger railways'],
      ['4121', 'Taxicabs and limousines'],
      ['4131', 'Bus lines'],
      ['4789', 'Transportation services — not elsewhere classified'],
      ['5541', 'Service stations'],
      ['5542', 'Automated fuel dispensers'],
      ['7523', 'Parking lots, garages'],
      ['4011', 'Railroads — freight'],
    ],
  },
  {
    id: 'education',
    label: 'Education & books',
    color: '#5B6CFF',
    codes: [
      ['8211', 'Elementary and secondary schools'],
      ['8220', 'Colleges, universities'],
      ['8244', 'Business and secretarial schools'],
      ['8249', 'Vocational and trade schools'],
      ['8299', 'Schools and educational services'],
      ['5942', 'Book stores'],
      ['5734', 'Computer software stores'],
    ],
  },
  {
    id: 'childcare',
    label: 'Childcare & family',
    color: '#D46B8C',
    codes: [
      ['8351', 'Child day care services'],
      ['5641', "Children's and infants' wear"],
      ['5945', 'Hobby, toy, and game shops'],
      ['7999', 'Recreation services'],
    ],
  },
  {
    id: 'clothing',
    label: 'Clothing',
    color: '#8B6B4A',
    codes: [
      ['5611', "Men's and boys' clothing"],
      ['5621', "Women's ready-to-wear"],
      ['5651', 'Family clothing stores'],
      ['5661', 'Shoe stores'],
      ['5691', "Men's and women's clothing stores"],
      ['5699', 'Miscellaneous apparel'],
    ],
  },
  {
    id: 'household',
    label: 'Household goods',
    color: '#6A8F71',
    codes: [
      ['5311', 'Department stores'],
      ['5331', 'Variety stores'],
      ['5399', 'Miscellaneous general merchandise'],
      ['5712', 'Furniture, home furnishings'],
      ['5719', 'Miscellaneous home furnishing'],
      ['5722', 'Household appliance stores'],
      ['5732', 'Electronics stores'],
      ['5947', 'Gift, card, novelty shops'],
    ],
  },
  {
    id: 'agri',
    label: 'Agriculture & farm inputs',
    color: '#6E8B3D',
    codes: [
      ['0763', 'Agricultural co-operatives'],
      ['0780', 'Landscaping and horticultural services'],
      ['5261', 'Nurseries, lawn and garden supply'],
      ['5085', 'Industrial supplies'],
    ],
  },
]

export const MCC_BY_CODE = Object.fromEntries(
  MCC_GROUPS.flatMap((g) =>
    g.codes.map(([code, name]) => [code, { code, name, groupId: g.id, group: g.label, color: g.color }]),
  ),
)

export function mccName(code) {
  return MCC_BY_CODE[code]?.name ?? `MCC ${code}`
}

export function mccGroup(code) {
  return MCC_BY_CODE[code]?.group ?? 'Other'
}

export function mccGroupId(code) {
  return MCC_BY_CODE[code]?.groupId ?? 'other'
}

export const PRESETS = {
  food: { label: 'Food assistance', groups: ['food'] },
  housing: { label: 'Housing / rent', groups: ['housing', 'energy'] },
  health: { label: 'Health & pharmacy', groups: ['health'] },
  living: { label: 'Basic living', groups: ['food', 'energy', 'household', 'clothing'] },
  family: { label: 'Family & childcare', groups: ['food', 'childcare', 'education', 'clothing'] },
  mobility: { label: 'Mobility', groups: ['transport'] },
  farm: { label: 'Agricultural inputs', groups: ['agri', 'energy'] },
}

export function codesForGroups(groupIds) {
  return MCC_GROUPS.filter((g) => groupIds.includes(g.id)).flatMap((g) => g.codes.map(([c]) => c))
}
