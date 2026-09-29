import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useDailyUsage } from '../hooks/useDailyUsage'
import { usePremium } from '../hooks/usePremium'
import Paywall from './Paywall'

const SESSION_FLAG = 'wakbu.usage.consumed'

interface Props { children: ReactNode }

export default function PremiumGate({ children }: Props) {
  const { user } = useAuth()
  const { isPremium, loading: premiumLoading } = usePremium()
  const { count, limit, reachedLimit, loading: usageLoading, consume, refresh } = useDailyUsage()
  const [dismissed, setDismissed] = useState(false)
  const consumeGuard = useRef(false)

  useEffect(() => {
    if (!user || usageLoading || premiumLoading) return
    if (isPremium) return
    if (consumeGuard.current) return
    if (sessionStorage.getItem(SESSION_FLAG) === '1') return
    consumeGuard.current = true
    void consume().finally(() => {
      sessionStorage.setItem(SESSION_FLAG, '1')
    })
  }, [user, usageLoading, premiumLoading, isPremium, consume])

  useEffect(() => {
    if (isPremium || !reachedLimit) setDismissed(false)
  }, [isPremium, reachedLimit])

  const showAutoPaywall = !isPremium && reachedLimit && !dismissed
  const reason = `오늘의 무료 사용(${limit}회, ${count}회 사용)을 모두 사용하셨어요. 프리미엄으로 무제한 이용해보세요.`

  return (
    <>
      {children}
      <Paywall
        open={showAutoPaywall}
        reason={reason}
        onClose={async () => {
          setDismissed(true)
          await refresh()
        }}
      />
    </>
  )
}
