import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { EN_LABELS, MESSAGES, type Locale } from './messages'

const STORAGE_KEY = 'wakbu.locale'

/** Auto-detect a supported UI locale from the browser / device settings.
 *  Falls back to English for any non-Korean browser so the app is
 *  approachable for international testers by default. */
function detectLocale(): Locale {
  if (typeof window === 'undefined') return 'en'
  const stored = window.localStorage.getItem(STORAGE_KEY) as Locale | null
  if (stored === 'ko' || stored === 'en') return stored
  const langs: string[] = (navigator.languages && navigator.languages.length ? [...navigator.languages] : [navigator.language])
    .filter(Boolean)
    .map((l) => l.toLowerCase())
  for (const l of langs) {
    if (l.startsWith('ko')) return 'ko'
  }
  return 'en'
}

interface LocaleContextValue {
  locale: Locale
  setLocale: (next: Locale) => void
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale())

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, locale) } catch { /* private mode */ }
    if (typeof document !== 'undefined') document.documentElement.lang = locale
  }, [locale])

  const value = useMemo<LocaleContextValue>(() => ({
    locale,
    setLocale: setLocaleState
  }), [locale])

  return createElement(LocaleContext.Provider, { value }, children)
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used inside <LocaleProvider>')
  return ctx
}

// Utility types to project a key path down to the pair (or function-pair)
// stored at that leaf. Callers get proper argument types back — e.g.
// t(m => m.paywall.savings)(25) returns string.
type Bilingual<T> = { ko: T; en: T }
type Resolve<T> = T extends Bilingual<infer V> ? V : never

/** Access translated strings via a typed selector.
 *
 *  Simple: `t(m => m.login.google)` → `'Continue with Google'` (string)
 *  Templated: `t(m => m.paywall.savings)(25)` → `'Save 25%'`
 *  Arrays: `t(m => m.paywall.benefits)` → `string[]`
 */
export function useT() {
  const { locale } = useLocale()
  return function t<S extends (m: typeof MESSAGES) => Bilingual<unknown>>(
    select: S
  ): Resolve<ReturnType<S>> {
    const pair = select(MESSAGES) as Bilingual<unknown>
    return pair[locale] as Resolve<ReturnType<S>>
  }
}

/** Fast Korean → English label lookup for preset/UI strings.
 *
 *  When locale is 'ko', returns the input unchanged. When 'en', looks up
 *  the English translation from `EN_LABELS`; if missing, falls back to
 *  the Korean string (safe default, visible signal to add a mapping).
 */
export function useTr() {
  const { locale } = useLocale()
  return useCallback((ko: string | null | undefined): string => {
    if (!ko) return ''
    if (locale === 'ko') return ko
    return EN_LABELS[ko] ?? ko
  }, [locale])
}
