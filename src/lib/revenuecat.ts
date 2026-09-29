import { Capacitor } from '@capacitor/core'
import { Purchases, LOG_LEVEL, type CustomerInfo } from '@revenuecat/purchases-capacitor'
import { ENV } from '../env'

let configured = false

const platformKey = (): string | null => {
  const p = Capacitor.getPlatform()
  if (p === 'android') return ENV.RC_ANDROID_KEY || null
  if (p === 'ios') return ENV.RC_IOS_KEY || null
  return null
}

export const isRevenueCatSupported = (): boolean => Capacitor.isNativePlatform() && !!platformKey()

export async function configureRevenueCat(appUserID: string): Promise<void> {
  if (!isRevenueCatSupported()) return
  const apiKey = platformKey()!
  if (!configured) {
    await Purchases.setLogLevel({ level: LOG_LEVEL.WARN })
    await Purchases.configure({ apiKey, appUserID })
    configured = true
  } else {
    await Purchases.logIn({ appUserID })
  }
}

export async function logOutRevenueCat(): Promise<void> {
  if (!isRevenueCatSupported() || !configured) return
  try {
    await Purchases.logOut()
  } catch {
    // logOut fails if user is anonymous — safe to ignore
  }
}

export async function getCustomerInfo(): Promise<CustomerInfo | null> {
  if (!isRevenueCatSupported() || !configured) return null
  const { customerInfo } = await Purchases.getCustomerInfo()
  return customerInfo
}

export function hasActiveEntitlement(info: CustomerInfo | null): boolean {
  if (!info) return false
  return !!info.entitlements.active[ENV.RC_ENTITLEMENT_ID]
}

export async function fetchOfferings() {
  if (!isRevenueCatSupported()) return null
  const { current } = await Purchases.getOfferings()
  return current ?? null
}

export { Purchases }
