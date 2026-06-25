import { AuthProvider, useAuth } from '@/hooks/use-auth'
import { LocaleProvider } from '@/i18n/LocaleProvider'
import { Login } from '@/portal/components/Login'
import { PortalShell } from '@/portal/PortalShell'

function Gate() {
  const { isAuthenticated } = useAuth()
  return isAuthenticated ? <PortalShell /> : <Login />
}

export default function App() {
  return (
    <LocaleProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </LocaleProvider>
  )
}
