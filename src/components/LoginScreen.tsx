import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import styles from './LoginScreen.module.css'

export default function LoginScreen() {
  const { signInWith, signingIn } = useAuth()
  const [error, setError] = useState<string | null>(null)

  const handle = async (provider: 'google' | 'kakao') => {
    setError(null)
    try {
      await signInWith(provider)
    } catch (err) {
      const message = err instanceof Error ? err.message : '로그인에 실패했어요. 다시 시도해주세요.'
      setError(message)
    }
  }

  const disabled = signingIn !== null

  return (
    <div className={styles.root}>
      <div className={styles.brand}>soundslime</div>
      <div className={styles.tagline}>
        로그인하고 나만의 슬라임을 저장해보세요.
      </div>
      <div className={styles.buttons}>
        <button
          className={`${styles.btn} ${styles.google}`}
          onClick={() => handle('google')}
          disabled={disabled}
        >
          <span className={styles.icon} aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
          </span>
          {signingIn === 'google' ? '연결 중…' : 'Google로 계속하기'}
        </button>
        <button
          className={`${styles.btn} ${styles.kakao}`}
          onClick={() => handle('kakao')}
          disabled={disabled}
        >
          <span className={styles.icon} aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path fill="#191600" d="M12 3C6.48 3 2 6.58 2 11c0 2.85 1.86 5.34 4.66 6.77l-.94 3.44a.4.4 0 0 0 .61.44l4.09-2.72c.52.06 1.05.07 1.58.07 5.52 0 10-3.58 10-8S17.52 3 12 3z"/>
            </svg>
          </span>
          {signingIn === 'kakao' ? '연결 중…' : '카카오로 계속하기'}
        </button>
      </div>
      {error && <div className={styles.error}>{error}</div>}
    </div>
  )
}

export function AuthSplash() {
  return <div className={styles.splash}>불러오는 중…</div>
}
