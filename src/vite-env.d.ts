/// <reference types="vite/client" />

declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_RC_ANDROID_KEY?: string
  readonly VITE_RC_IOS_KEY?: string
  readonly VITE_OAUTH_REDIRECT_URL?: string
  readonly VITE_RC_ENTITLEMENT_ID?: string
  readonly VITE_FREE_DAILY_LIMIT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

