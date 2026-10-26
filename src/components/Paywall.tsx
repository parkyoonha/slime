import { useEffect, useState } from 'react'
import type { PurchasesPackage, PurchasesOffering } from '@revenuecat/purchases-capacitor'
import { fetchOfferings, isRevenueCatSupported, Purchases } from '../lib/revenuecat'
import { usePremium } from '../hooks/usePremium'
import styles from './Paywall.module.css'

interface Props {
  open: boolean
  reason?: string
  onClose: () => void
}

const BENEFITS = [
  '무제한 슬라임 만지기',
  '프리미엄 프리셋 & 이모지팩',
  '광고 없이 매끄러운 경험',
  '한 번 결제로 평생 사용'
]

function periodLabel(pkg: PurchasesPackage): string {
  // Non-consumable IAP — "buy once, keep forever". No period semantics.
  return pkg.product.title || '평생 이용권'
}

export default function Paywall({ open, reason, onClose }: Props) {
  const { isPremium, refresh } = usePremium()
  const [offering, setOffering] = useState<PurchasesOffering | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState<'purchase' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    if (!isRevenueCatSupported()) {
      setError('현재 플랫폼에서는 결제를 지원하지 않아요. 안드로이드 앱에서 다시 시도해주세요.')
      return
    }
    fetchOfferings()
      .then((o) => {
        setOffering(o)
        const preferred = o?.annual ?? o?.monthly ?? o?.availablePackages[0] ?? null
        setSelected(preferred?.identifier ?? null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [open])

  useEffect(() => {
    if (isPremium && open) onClose()
  }, [isPremium, open, onClose])

  const packages = offering?.availablePackages ?? []

  if (!open) return null

  const handlePurchase = async () => {
    const pkg = packages.find((p) => p.identifier === selected)
    if (!pkg) return
    setBusy('purchase')
    setError(null)
    try {
      const result = await Purchases.purchasePackage({ aPackage: pkg })
      if (result?.customerInfo) await refresh()
    } catch (err: unknown) {
      const e = err as { userCancelled?: boolean; message?: string }
      if (!e?.userCancelled) setError(e?.message ?? '결제에 실패했어요.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>soundslime 프리미엄</div>
            <div className={styles.subtitle}>{reason ?? '한 번 결제로 평생 사용하세요.'}</div>
          </div>
          <button className={styles.close} onClick={onClose} aria-label="닫기">×</button>
        </div>

        <ul className={styles.benefits}>
          {BENEFITS.map((b) => (
            <li key={b}><span className={styles.check}>✓</span>{b}</li>
          ))}
        </ul>

        <div className={styles.options}>
          {packages.length === 0 && !error && (
            <div className={styles.subtitle}>상품을 불러오는 중…</div>
          )}
          {packages.map((pkg) => (
            <button
              key={pkg.identifier}
              className={styles.option}
              data-selected={selected === pkg.identifier}
              onClick={() => setSelected(pkg.identifier)}
            >
              <div className={styles.optionMain}>
                <div className={styles.optionLabel}>{periodLabel(pkg)}</div>
                <div className={styles.optionMeta}>{pkg.product.description || pkg.product.title}</div>
              </div>
              <div className={styles.optionPrice}>{pkg.product.priceString}</div>
            </button>
          ))}
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <button
          className={styles.purchase}
          onClick={handlePurchase}
          disabled={!selected || busy !== null}
        >
          {busy === 'purchase' ? '결제 중…' : '프리미엄 구매하기'}
        </button>

        <div className={styles.notice}>
          Google Play를 통해 결제되며, 한 번 결제 후 평생 사용 가능합니다. 환불은 Google Play 정책을 따릅니다.
        </div>
      </div>
    </div>
  )
}
