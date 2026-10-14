import { useState } from "react"
import { useNavigate, Link } from "react-router-dom"
import { Loader2, Eye, EyeOff, Users } from "lucide-react"
import { Button } from "@food/components/ui/button"
import { Label } from "@food/components/ui/label"
import { restaurantAPI } from "@food/api"
import { setAuthData } from "@food/utils/auth"
import { firstOpenRestaurantPath } from "@food/utils/restaurantPermissions"
import { useCompanyName } from "@food/hooks/useCompanyName"
import RestaurantPartnerHero from "@food/components/restaurant/auth/RestaurantPartnerHero"

const THEME = "#008078"

/**
 * Staff sign-in for the restaurant panel (old store panel: Employee login).
 * Email or phone + the password the owner set; the session is the
 * restaurant's, limited to the employee's role.
 */
export default function RestaurantEmployeeLogin() {
  const companyName = useCompanyName()
  const navigate = useNavigate()
  const [identifier, setIdentifier] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!identifier.trim()) return setError("Enter your email or phone")
    if (!password) return setError("Enter your password")
    try {
      setLoading(true)
      setError("")
      const res = await restaurantAPI.employeeLogin(identifier, password)
      const data = res?.data?.data || res?.data
      if (!data?.accessToken) throw new Error("Login failed")
      setAuthData("restaurant", data.accessToken, data.user, data.refreshToken ?? null)
      window.dispatchEvent(new Event("restaurantAuthChanged"))
      navigate(firstOpenRestaurantPath(), { replace: true })
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || "Login failed")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-[100dvh] bg-white">
      <div className="hidden lg:block lg:w-1/2">
        <RestaurantPartnerHero themeColor={THEME} />
      </div>
      <div className="flex w-full flex-col items-center justify-center bg-[#F0F2F5] px-5 py-8 sm:px-10 lg:w-1/2">
        <div className="w-full max-w-[380px]">
          <div className="mb-7 text-center lg:text-left">
            <div className="mb-5 flex justify-center lg:justify-start">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
                <Users className="h-6 w-6" style={{ color: THEME }} aria-hidden="true" />
              </div>
            </div>
            <h2 className="text-2xl font-bold tracking-tight text-gray-900">Employee sign in</h2>
            <p className="mt-1 text-sm text-gray-500">Use the email or phone and password your restaurant gave you</p>
          </div>

          <form onSubmit={submit} className="space-y-4 rounded-2xl border border-gray-200 bg-white p-6 shadow-[0_4px_24px_rgba(0,0,0,0.08)] sm:p-7">
            {error && (
              <div role="alert" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600">
                {error}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="employee-identifier" className="text-sm font-medium text-gray-700">Email or phone</Label>
              <input
                id="employee-identifier"
                autoComplete="username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="you@example.com or 98765 43210"
                className="h-12 w-full rounded-xl border border-gray-200 px-4 text-base text-gray-900 outline-none focus:ring-2 focus:ring-[#008078]/30"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="employee-password" className="text-sm font-medium text-gray-700">Password</Label>
              <div className="flex items-center rounded-xl border border-gray-200 focus-within:ring-2 focus-within:ring-[#008078]/30">
                <input
                  id="employee-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-12 w-full rounded-xl border-0 bg-transparent px-4 text-base text-gray-900 outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="px-3 text-gray-500"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <Button
              type="submit"
              disabled={loading}
              variant="ghost"
              className="h-12 w-full rounded-xl text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: THEME }}
            >
              {loading ? (<><Loader2 className="h-4 w-4 animate-spin" /> Signing in...</>) : "Sign in"}
            </Button>
          </form>

          <p className="mt-5 text-center text-sm text-gray-500">
            Restaurant owner?{" "}
            <Link to="/food/restaurant/login" className="font-semibold" style={{ color: THEME }}>Sign in with OTP</Link>
          </p>
          <p className="mt-2 text-center text-xs text-gray-400">Secure staff login &middot; {companyName}</p>
        </div>
      </div>
    </div>
  )
}
