import { useMemo, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Browser } from '@capacitor/browser'
import { useAuth } from '../auth/AuthContext'
import { usePremium } from '../hooks/usePremium'
import { useDailyUsage } from '../hooks/useDailyUsage'
import { isRevenueCatSupported, Purchases } from '../lib/revenuecat'
import Paywall from './Paywall'
import styles from './AccountDrawerSection.module.css'

const BENEFITS = [
  '무제한 슬라임 만지기',
  '컬렉션 무제한 저장 · 기기 간 동기화',
  '슬라임멍 세션 확장 (기본 3분 → 최대 20분)',
  '광고 제거'
]

function initialFor(name: string | null | undefined, email: string | null | undefined): string {
  const base = (name && name.trim()) || (email && email.split('@')[0]) || '?'
  return base.charAt(0).toUpperCase()
}

function formatExpiry(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })
}

interface Props { onCloseDrawer?: () => void }

/** Top part of the drawer: subscription status card + action buttons. */
export function AccountDrawerTop({ onCloseDrawer }: Props) {
  const { isPremium, customerInfo, refresh } = usePremium()
  const { count, limit } = useDailyUsage()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [paywallOpen, setPaywallOpen] = useState(false)
  const [busy, setBusy] = useState<'restore' | 'manage' | null>(null)

  const expiryLabel = useMemo(() => {
    if (!customerInfo) return null
    const ent = customerInfo.entitlements.active['premium']
    return formatExpiry(ent?.expirationDate)
  }, [customerInfo])

  const handleSubscribe = () => {
    setDetailsOpen(false)
    setPaywallOpen(true)
  }

  const handleRestore = async () => {
    if (!isRevenueCatSupported()) return
    setBusy('restore')
    try {
      await Purchases.restorePurchases()
      await refresh()
    } catch {
      /* ignore — user will see status or lack thereof */
    } finally {
      setBusy(null)
    }
  }

  const handleManage = async () => {
    if (!Capacitor.isNativePlatform()) return
    setBusy('manage')
    try {
      await Browser.open({ url: 'https://play.google.com/store/account/subscriptions?package=io.wakbu.slime' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <button className={styles.card} onClick={() => setDetailsOpen(true)}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>구독 상태</span>
          <span className={isPremium ? styles.badgePro : styles.badgeFree}>
            {isPremium ? 'PRO' : 'FREE'}
          </span>
        </div>
        <div className={styles.status}>
          {isPremium ? '프리미엄' : `무료 (${count}/${limit} 사용)`}
        </div>
        {isPremium && expiryLabel && (
          <div className={styles.subLine}>{expiryLabel}까지</div>
        )}
        {!isPremium && (
          <button
            type="button"
            className={styles.subscribeBtn}
            onClick={(e) => { e.stopPropagation(); handleSubscribe() }}
          >
            프리미엄 구독하기
          </button>
        )}
      </button>

      <button
        type="button"
        className={styles.actionBtn}
        onClick={handleRestore}
        disabled={busy !== null || !isRevenueCatSupported()}
      >
        <span>{busy === 'restore' ? '복원 중…' : '구매 복원'}</span>
        <span className={styles.chevron}>›</span>
      </button>

      {detailsOpen && (
        <div className={styles.detailsBackdrop} onClick={() => setDetailsOpen(false)}>
          <div className={styles.detailsCard} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
            <div className={styles.detailsHeader}>
              <div className={styles.detailsTitle}>구독 정보</div>
              <button className={styles.detailsClose} onClick={() => setDetailsOpen(false)} aria-label="닫기">×</button>
            </div>
            <div className={styles.detailsSummary}>
              <div className={styles.status}>
                {isPremium ? '프리미엄' : `무료 (${count}/${limit})`}
              </div>
              <span className={isPremium ? styles.badgePro : styles.badgeFree}>
                {isPremium ? 'PRO' : 'FREE'}
              </span>
            </div>
            {isPremium && expiryLabel && (
              <div className={styles.subLine}>{expiryLabel}까지 이용 가능</div>
            )}
            <ul className={styles.benefitList}>
              {BENEFITS.map((b) => <li key={b}>{b}</li>)}
            </ul>
            <div className={styles.detailsActions}>
              {!isPremium && (
                <button className={styles.primaryBtn} onClick={handleSubscribe}>
                  프리미엄 구독하기
                </button>
              )}
              {isPremium && Capacitor.isNativePlatform() && (
                <button className={styles.primaryBtn} onClick={handleManage} disabled={busy !== null}>
                  {busy === 'manage' ? '여는 중…' : 'Play 스토어에서 구독 관리'}
                </button>
              )}
              <button
                className={styles.secondaryBtn}
                onClick={handleRestore}
                disabled={busy !== null || !isRevenueCatSupported()}
              >
                {busy === 'restore' ? '복원 중…' : '구매 복원'}
              </button>
            </div>
          </div>
        </div>
      )}

      <Paywall
        open={paywallOpen}
        onClose={async () => {
          setPaywallOpen(false)
          await refresh()
          onCloseDrawer?.()
        }}
      />
    </>
  )
}

/** Bottom slot: profile info + logout. */
export function AccountDrawerFooter({ onCloseDrawer }: Props) {
  const { user, signOut } = useAuth()
  const [signingOut, setSigningOut] = useState(false)

  const profile = user?.user_metadata ?? {}
  const displayName = (profile.name as string | undefined) ?? (profile.full_name as string | undefined) ?? null
  const avatarUrl = (profile.avatar_url as string | undefined) ?? (profile.picture as string | undefined) ?? null
  const email = user?.email ?? null

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      sessionStorage.removeItem('wakbu.usage.consumed')
      await signOut()
    } finally {
      setSigningOut(false)
      onCloseDrawer?.()
    }
  }

  return (
    <div className={styles.footer}>
      <div className={styles.profile}>
        <div className={styles.avatar}>
          {avatarUrl ? <img src={avatarUrl} alt="" /> : initialFor(displayName, email)}
        </div>
        <div className={styles.profileText}>
          <div className={styles.name}>{displayName ?? email ?? '사용자'}</div>
          {email && displayName && <div className={styles.email}>{email}</div>}
        </div>
      </div>
      <button className={styles.logout} onClick={handleSignOut} disabled={signingOut}>
        <span>{signingOut ? '로그아웃 중…' : '로그아웃'}</span>
        <span className={styles.chevron}>›</span>
      </button>
    </div>
  )
}
