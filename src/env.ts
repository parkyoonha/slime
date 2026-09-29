const required = (key: string, value: string | undefined): string => {
  if (!value) throw new Error(`Missing env: ${key} — set it in .env.local`)
  return value
}

export const ENV = {
  SUPABASE_URL: required('VITE_SUPABASE_URL', import.meta.env.VITE_SUPABASE_URL),
  SUPABASE_ANON_KEY: required('VITE_SUPABASE_ANON_KEY', import.meta.env.VITE_SUPABASE_ANON_KEY),
  RC_ANDROID_KEY: import.meta.env.VITE_RC_ANDROID_KEY ?? '',
  RC_IOS_KEY: import.meta.env.VITE_RC_IOS_KEY ?? '',
  OAUTH_REDIRECT_URL: import.meta.env.VITE_OAUTH_REDIRECT_URL ?? 'io.wakbu.slime://auth/callback',
  RC_ENTITLEMENT_ID: import.meta.env.VITE_RC_ENTITLEMENT_ID ?? 'premium',
  FREE_DAILY_LIMIT: Number(import.meta.env.VITE_FREE_DAILY_LIMIT ?? 5)
} as const
