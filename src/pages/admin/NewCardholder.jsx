import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../../store.jsx'
import { COUNTRIES } from '../../data/agencies.js'

export default function NewCardholder() {
  const { country, createCardholder } = useStore()
  const nav = useNavigate()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [city, setCity] = useState('')
  const [homeCountry, setHomeCountry] = useState(country)

  function submit(e) {
    e.preventDefault()
    const person = createCardholder({ firstName, lastName, email, phone, city, country: homeCountry })
    nav('/admin/cardholders', { state: { created: person.id } })
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>New cardholder</h2>
      <p style={{ color: 'var(--muted)' }}>
        Issues a Lithic-shaped virtual card. Envelope credits arrive later from a connection hook.
      </p>
      <div className="row-2">
        <div className="field">
          <label htmlFor="fn">First name</label>
          <input id="fn" required value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ln">Last name</label>
          <input id="ln" required value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </div>
      </div>
      <div className="row-2">
        <div className="field">
          <label htmlFor="em">Email</label>
          <input id="em" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ph">Phone</label>
          <input id="ph" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      </div>
      <div className="row-2">
        <div className="field">
          <label htmlFor="city">City</label>
          <input id="city" required value={city} onChange={(e) => setCity(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cc">Country</label>
          <select id="cc" value={homeCountry} onChange={(e) => setHomeCountry(e.target.value)}>
            {COUNTRIES.filter((c) => c.code !== 'EU').map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <button className="btn" type="submit">
        Issue virtual card
      </button>
    </form>
  )
}
