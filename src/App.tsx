import SlimeApp from './components/SlimeApp'
import LoginScreen, { AuthSplash } from './components/LoginScreen'
import PremiumGate from './components/PremiumGate'
import { AuthProvider, useAuth } from './auth/AuthContext'

function Gate() {
  const { session, loading } = useAuth()
  if (loading) return <AuthSplash />
  if (!session) return <LoginScreen />
  return (
    <PremiumGate>
      <SlimeApp />
    </PremiumGate>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
