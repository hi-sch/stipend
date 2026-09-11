import { toAlpha3 } from '../data/agencies.js'

const MCC_FROM_OSM = [
  [/supermarket|grocery|convenience|greengrocer/i, '5411'],
  [/bakery/i, '5462'],
  [/pharmacy|chemist|drugstore/i, '5912'],
  [/fuel|gas_station|charging/i, '5541'],
  [/restaurant|fast_food|food_court/i, '5812'],
  [/cafe|coffee/i, '5812'],
  [/hospital|clinic/i, '8062'],
  [/doctors|dentist/i, '8011'],
  [/clothes|fashion|boutique/i, '5651'],
  [/furniture|ikea/i, '5712'],
  [/bus|tram|subway|railway|public_transport/i, '4111'],
  [/hairdresser|beauty/i, '7230'],
]

export function mccFromTags(tags = {}) {
  const blob = [tags.shop, tags.amenity, tags.craft, tags.healthcare, tags.name].filter(Boolean).join(' ')
  for (const [re, code] of MCC_FROM_OSM) {
    if (re.test(blob)) return code
  }
  return '5411'
}

export function locateMerchant() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location is not available in this browser.'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          resolve(await lookup(pos.coords.latitude, pos.coords.longitude))
        } catch (err) {
          reject(err)
        }
      },
      () => reject(new Error('Location permission was denied or timed out.')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    )
  })
}

async function lookup(lat, lon) {
  const nearby = await nearbyPlace(lat, lon)
  const reverse = nearby || (await reverseGeocode(lat, lon))
  return reverse
}

async function nearbyPlace(lat, lon) {
  const query = `[out:json][timeout:8];(node(around:180,${lat},${lon})[name][shop];node(around:180,${lat},${lon})[name][amenity];way(around:180,${lat},${lon})[name][shop];);out center 8;`
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: `data=${encodeURIComponent(query)}`,
  })
  if (!res.ok) return null
  const data = await res.json()
  const el = data.elements?.find((e) => e.tags?.name)
  if (!el) return null
  const tags = el.tags
  return {
    merchant: tags.name,
    city: tags['addr:city'] || tags['addr:suburb'] || '',
    mcc: mccFromTags(tags),
    country: toAlpha3(tags['addr:country'] || ''),
    lat,
    lon,
  }
}

async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=18&addressdetails=1`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error('Could not resolve this location.')
  const data = await res.json()
  const addr = data.address || {}
  const name =
    data.name ||
    addr.shop ||
    addr.amenity ||
    addr.building ||
    [addr.road, addr.house_number].filter(Boolean).join(' ') ||
    'Nearby merchant'
  return {
    merchant: name,
    city: addr.city || addr.town || addr.village || addr.suburb || '',
    mcc: mccFromTags({ name, amenity: addr.amenity, shop: addr.shop }),
    country: toAlpha3(addr.country_code),
    lat,
    lon,
  }
}
