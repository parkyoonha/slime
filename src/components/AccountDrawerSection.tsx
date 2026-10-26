import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { usePremium } from '../hooks/usePremium'
import Paywall from './Paywall'
import styles from './AccountDrawerSection.module.css'

const BENEFITS = [
  '무제한 슬라임 만지기',
  '컬렉션 무제한 저장 · 기기 간 동기화',
  '슬라임멍 세션 확장 (기본 3분 → 최대 20분)',
  '광고 제거',
  '한 번 결제로 평생 사용'
]

function initialFor(name: string | null | undefined, email: string | null | undefined): string {
  const base = (name && name.trim()) || (email && email.split('@')[0]) || '?'
  return base.charAt(0).toUpperCase()
}

interface Props { onCloseDrawer?: () => void }

/** Top part of the drawer: single "프리미엄 구매하기" button that opens
 *  a benefits-list modal; the modal in turn has the real "구매하기" that
 *  opens the Paywall. No status card / badge / usage counter in the
 *  drawer itself (stripped per UX request) — just the one CTA button.
 *  Premium users see nothing here. */
export function AccountDrawerTop({ onCloseDrawer }: Props) {
  const { isPremium, refresh } = usePremium()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [paywallOpen, setPaywallOpen] = useState(false)

  const handleSubscribe = () => {
    setDetailsOpen(false)
    setPaywallOpen(true)
  }

  return (
    <>
      {!isPremium && (
        <button
          type="button"
          className={styles.subscribeBtn}
          onClick={() => setDetailsOpen(true)}
        >
          프리미엄 구매하기
        </button>
      )}

      {detailsOpen && (
        <div className={styles.detailsBackdrop} onClick={() => setDetailsOpen(false)}>
          <div className={styles.detailsCard} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
            <div className={styles.detailsHeader}>
              <div className={styles.detailsTitle}>프리미엄</div>
              <button className={styles.detailsClose} onClick={() => setDetailsOpen(false)} aria-label="닫기">×</button>
            </div>
            <ul className={styles.benefitList}>
              {BENEFITS.map((b) => <li key={b}>{b}</li>)}
            </ul>
            <div className={styles.detailsActions}>
              <button className={styles.primaryBtn} onClick={handleSubscribe}>
                프리미엄 구매하기
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
