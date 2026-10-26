import { useEffect } from 'react'
import { usePremium } from '../hooks/usePremium'
import {
  hideBanner,
  initializeAdMob,
  isAdMobSupported,
  prepareInterstitial,
  removeBanner,
  showBottomBanner
} from '../lib/admob'

/** Mount this once at app root (inside the auth gate). Shows a bottom
 *  banner on native Android while the user is on the free tier, and
 *  removes it the moment they become premium. Also preloads the save-
 *  gate interstitial so `showInterstitial()` resolves instantly when
 *  the user hits save. No-op on web. */
export default function AdBanner() {
  const { isPremium, loading } = usePremium()

  useEffect(() => {
    if (!isAdMobSupported()) return
    void (async () => {
      await initializeAdMob()
      void prepareInterstitial()
    })()
  }, [])

  useEffect(() => {
    if (!isAdMobSupported() || loading) return
    if (isPremium) {
      void removeBanner()
      return
    }
    void showBottomBanner()
    return () => { void hideBanner() }
  }, [isPremium, loading])

  return null
}
