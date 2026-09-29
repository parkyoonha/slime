import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { ENV } from '../env'
import { usePremium } from './usePremium'

interface UsageRow { count: number; usage_date: string }

interface UsageState {
  count: number
  limit: number
  remaining: number
  reachedLimit: boolean
  loading: boolean
  /** Attempt to consume one usage. Returns true if allowed (or premium),
   *  false if the free-tier cap has been reached. */
  consume: () => Promise<boolean>
  refresh: () => Promise<void>
}

const FREE_LIMIT = Math.max(0, ENV.FREE_DAILY_LIMIT)

export function useDailyUsage(): UsageState {
  const { user } = useAuth()
  const { isPremium } = usePremium()
  const [count, setCount] = useState(0)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!user) { setCount(0); setLoading(false); return }
    const { data, error } = await supabase.rpc('get_daily_usage')
    if (!error && data) {
      const row = Array.isArray(data) ? (data[0] as UsageRow | undefined) : (data as UsageRow)
      setCount(row?.count ?? 0)
    }
    setLoading(false)
  }, [user])

  useEffect(() => {
    setLoading(true)
    void refresh()
  }, [refresh])

  const consume = useCallback(async (): Promise<boolean> => {
    if (isPremium) return true
    if (!user) return false
    if (count >= FREE_LIMIT) return false
    const { data, error } = await supabase.rpc('increment_daily_usage')
    if (error) return false
    const row = Array.isArray(data) ? (data[0] as UsageRow | undefined) : (data as UsageRow)
    const next = row?.count ?? count + 1
    setCount(next)
    return next <= FREE_LIMIT
  }, [count, isPremium, user])

  const remaining = Math.max(0, FREE_LIMIT - count)
  const reachedLimit = !isPremium && count >= FREE_LIMIT

  return { count, limit: FREE_LIMIT, remaining, reachedLimit, loading, consume, refresh }
}
