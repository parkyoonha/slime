import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { Capacitor } from '@capacitor/core'
import { App, type URLOpenListenerEvent } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { supabase } from '../lib/supabase'
import { ENV } from '../env'
import { configureRevenueCat, logOutRevenueCat } from '../lib/revenuecat'

type Provider = 'google' | 'kakao'

interface AuthContextValue {
  session: Session | null
  user: User | null
  loading: boolean
  signingIn: Provider | null
  signInWith: (provider: Provider) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

async function exchangeCodeFromUrl(url: string): Promise<void> {
  const parsed = new URL(url)
  const code = parsed.searchParams.get('code') ?? new URLSearchParams(parsed.hash.replace(/^#/, '')).get('code')
  if (!code) return
  await supabase.auth.exchangeCodeForSession(code)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [signingIn, setSigningIn] = useState<Provider | null>(null)
  const rcConfigured = useRef<string | null>(null)

  useEffect(() => {
    let mounted = true
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
    })
    return () => {
      mounted = false
      sub.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let removed = false
    let handle: { remove: () => Promise<void> } | null = null
    App.addListener('appUrlOpen', async (event: URLOpenListenerEvent) => {
      if (!event.url.startsWith(ENV.OAUTH_REDIRECT_URL.split('://')[0] + '://')) return
      try {
        await exchangeCodeFromUrl(event.url)
      } catch (err) {
        console.error('OAuth exchange failed', err)
      } finally {
        try { await Browser.close() } catch { /* browser may already be closed */ }
        setSigningIn(null)
      }
    }).then((h) => {
      if (removed) { h.remove() } else { handle = h }
    })
    return () => {
      removed = true
      handle?.remove()
    }
  }, [])

  useEffect(() => {
    const userId = session?.user.id
    if (!userId) {
      if (rcConfigured.current) {
        logOutRevenueCat().catch(() => {})
        rcConfigured.current = null
      }
      return
    }
    if (rcConfigured.current === userId) return
    configureRevenueCat(userId)
      .then(() => { rcConfigured.current = userId })
      .catch((err) => console.warn('RevenueCat configure failed', err))
  }, [session?.user.id])

  const signInWith = useCallback(async (provider: Provider) => {
    setSigningIn(provider)
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: ENV.OAUTH_REDIRECT_URL,
          skipBrowserRedirect: Capacitor.isNativePlatform()
        }
      })
      if (error) throw error
      if (Capacitor.isNativePlatform() && data.url) {
        await Browser.open({ url: data.url, presentationStyle: 'popover' })
      }
    } catch (err) {
      setSigningIn(null)
      throw err
    }
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])

  const value = useMemo<AuthContextValue>(() => ({
    session,
    user: session?.user ?? null,
    loading,
    signingIn,
    signInWith,
    signOut
  }), [session, loading, signingIn, signInWith, signOut])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
