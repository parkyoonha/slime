import { Capacitor } from '@capacitor/core'
import {
  AdMob,
  BannerAdPluginEvents,
  BannerAdPosition,
  BannerAdSize,
  type BannerAdOptions,
  type AdOptions
} from '@capacitor-community/admob'
import { ENV } from '../env'

/** Google's documented always-filled Android test units. Safe to use
 *  during development — never show real ads, never bill. */
const TEST_BANNER_ANDROID = 'ca-app-pub-3940256099942544/6300978111'
const TEST_INTERSTITIAL_ANDROID = 'ca-app-pub-3940256099942544/1033173712'

let initialized = false
let interstitialReady = false
let bannerListenersBound = false

/** Publishes the native banner's measured height to --ad-banner-height
 *  on <html>. CSS reserves matching bottom space ONLY WHEN AN AD IS
 *  ACTUALLY VISIBLE. When the banner is hidden, not filled, or failed
 *  to load, this drops back to 0 and the UI returns to default. */
function setBannerHeightCssVar(heightPx: number) {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty(
    '--ad-banner-height',
    `${Math.max(0, Math.round(heightPx))}px`
  )
}

function ensureBannerListeners() {
  if (bannerListenersBound) return
  bannerListenersBound = true
  void AdMob.addListener(
    BannerAdPluginEvents.SizeChanged,
    (info: { width: number; height: number }) => {
      setBannerHeightCssVar(info?.height ?? 0)
    }
  )
  void AdMob.addListener(BannerAdPluginEvents.FailedToLoad, () => {
    setBannerHeightCssVar(0)
  })
}

export const isAdMobSupported = (): boolean => Capacitor.getPlatform() === 'android'

export async function initializeAdMob(): Promise<void> {
  if (!isAdMobSupported() || initialized) return
  try {
    await AdMob.initialize({
      testingDevices: [],
      initializeForTesting: ENV.ADMOB_TESTING
    })
    initialized = true
  } catch (err) {
    console.warn('AdMob initialize failed', err)
  }
}

export async function showBottomBanner(): Promise<void> {
  if (!isAdMobSupported()) return
  ensureBannerListeners()
  const adId = ENV.ADMOB_TESTING
    ? TEST_BANNER_ANDROID
    : (ENV.ADMOB_ANDROID_BANNER || TEST_BANNER_ANDROID)
  const options: BannerAdOptions = {
    adId,
    // IMPORTANT: must stay ADAPTIVE_BANNER. Switching to fixed BANNER
    // (320x50) triggers a NullPointerException in BannerExecutor on
    // Android 16 (API 36) via the plugin's WindowInsets callback path.
    // ADAPTIVE_BANNER goes through a different code branch in the
    // plugin that doesn't deref the broken field. Confirmed by swapping
    // back and forth: ADAPTIVE works, BANNER crashes. Do not change.
    adSize: BannerAdSize.ADAPTIVE_BANNER,
    position: BannerAdPosition.BOTTOM_CENTER,
    margin: 0,
    isTesting: ENV.ADMOB_TESTING
  }
  try {
    await AdMob.showBanner(options)
  } catch (err) {
    console.warn('AdMob showBanner failed', err)
    setBannerHeightCssVar(0)
  }
}

export async function hideBanner(): Promise<void> {
  if (!isAdMobSupported()) return
  try { await AdMob.hideBanner() } catch { /* already hidden */ }
  setBannerHeightCssVar(0)
}

export async function removeBanner(): Promise<void> {
  if (!isAdMobSupported()) return
  try { await AdMob.removeBanner() } catch { /* already removed */ }
  setBannerHeightCssVar(0)
}

function interstitialId(): string {
  return ENV.ADMOB_TESTING
    ? TEST_INTERSTITIAL_ANDROID
    : (ENV.ADMOB_ANDROID_INTERSTITIAL || TEST_INTERSTITIAL_ANDROID)
}

/** Preload the next interstitial so `showInterstitial()` is instant.
 *  Safe to call multiple times — no-ops if one is already ready. */
export async function prepareInterstitial(): Promise<void> {
  if (!isAdMobSupported() || interstitialReady) return
  const options: AdOptions = {
    adId: interstitialId(),
    isTesting: ENV.ADMOB_TESTING
  }
  try {
    await AdMob.prepareInterstitial(options)
    interstitialReady = true
  } catch (err) {
    console.warn('AdMob prepareInterstitial failed', err)
    interstitialReady = false
  }
}

/** Show the preloaded interstitial. If none is ready, loads one on
 *  demand (which can block for a few seconds). Resolves when the ad
 *  is dismissed OR immediately if the user is on an unsupported
 *  platform. Callers should treat resolution as "proceed with your
 *  gated action" regardless of outcome — ads must not permanently
 *  block user actions. */
export async function showInterstitial(): Promise<void> {
  if (!isAdMobSupported()) return
  try {
    if (!interstitialReady) await prepareInterstitial()
    if (!interstitialReady) return
    await AdMob.showInterstitial()
  } catch (err) {
    console.warn('AdMob showInterstitial failed', err)
  } finally {
    interstitialReady = false
    // Preload the next one so the next gated action is instant.
    void prepareInterstitial()
  }
}
