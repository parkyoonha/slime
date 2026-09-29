import { useCallback, useEffect, useState } from 'react'
import type { CustomerInfo } from '@revenuecat/purchases-capacitor'
import { Capacitor } from '@capacitor/core'
import { useAuth } from '../auth/AuthContext'
import { getCustomerInfo, hasActiveEntitlement, Purchases, isRevenueCatSupported } from '../lib/revenuecat'

interface PremiumState {
  isPremium: boolean
  loading: boolean
  refresh: () => Promise<void>
  customerInfo: CustomerInfo | null
}

export function usePremium(): PremiumState {
  const { user } = useAuth()
  const [info, setInfo] = useState<CustomerInfo | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!user || !isRevenueCatSupported()) {
      setInfo(null)
      setLoading(false)
      return
    }
    try {
      const next = await getCustomerInfo()
      setInfo(next)
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    setLoading(true)
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!isRevenueCatSupported() || !Capacitor.isNativePlatform()) return
    let disposed = false
    let listenerId: string | null = null
    Purchases.addCustomerInfoUpdateListener((next) => {
      setInfo(next)
    }).then((id) => {
      if (disposed) {
        void Purchases.removeCustomerInfoUpdateListener({ listenerToRemove: id })
      } else {
        listenerId = id
      }
    }).catch(() => {})
    return () => {
      disposed = true
      if (listenerId) {
        void Purchases.removeCustomerInfoUpdateListener({ listenerToRemove: listenerId })
      }
    }
  }, [])

  return {
    isPremium: hasActiveEntitlement(info),
    loading,
    refresh,
    customerInfo: info
  }
}
