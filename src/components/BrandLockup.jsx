import { HugeiconsIcon } from '@hugeicons/react'
import { CreditCardPosIcon } from '@hugeicons/core-free-icons'

export default function BrandLockup() {
  return (
    <div className="brand">
      <span className="brand-ico" aria-hidden="true">
        <HugeiconsIcon icon={CreditCardPosIcon} size={24} color="#1a1a1a" strokeWidth={1.5} />
      </span>
      <span className="brand-word">stipend</span>
    </div>
  )
}
