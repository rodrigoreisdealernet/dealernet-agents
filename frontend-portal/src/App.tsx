import { AuthProvider, useAuth } from '@/hooks/use-auth'
import { Login } from '@/portal/components/Login'
import { PortalShell } from '@/portal/PortalShell'

function Gate() {
  const { isAuthenticated } = useAuth()
  return isAuthenticated ? <PortalShell /> : <Login />
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
