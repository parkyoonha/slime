import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// Fade out the boot splash defined in index.html. Waits until at least
// 850 ms have passed since the HTML started rendering so users always
// see the logo — a fast cold start would otherwise flash it for one
// frame and immediately reveal the slime, which reads as a stutter
// rather than an intentional splash. If React took longer than 850 ms
// to mount, `remaining` clamps to 0 and the splash removes right away.
{
  const start =
    typeof window !== 'undefined'
      ? ((window as unknown as { __splashStart?: number }).__splashStart ??
          Date.now())
      : Date.now()
  const remaining = Math.max(0, 850 - (Date.now() - start))
  window.setTimeout(() => {
    const el = document.getElementById('splash')
    if (!el) return
    el.classList.add('fade')
    window.setTimeout(() => el.remove(), 300)
  }, remaining)
}
