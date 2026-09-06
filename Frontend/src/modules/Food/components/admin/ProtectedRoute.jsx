import { useEffect, useState } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { adminAPI } from "@food/api"
import {
  clearModuleAuth,
  ensureValidAccessToken,
  getCurrentUser,
  isModuleAuthenticated,
  setAuthData,
} from "@food/utils/auth"
import { canAccessAdminPath, findFirstAllowedAdminPath } from "@food/utils/adminRbac"

export default function ProtectedRoute({ children }) {
  const location = useLocation()
  const [status, setStatus] = useState(() =>
    isModuleAuthenticated("admin") ? "checking" : "deny"
  )

  // Once, on mount -- not on every navigation.
  //
  // This used to depend on location.pathname, so every sidebar click set
  // status back to "checking", which renders the blank div below in place of
  // the entire panel, fired a profile request, and only restored the tree
  // when it came back. The whole admin panel unmounted and remounted -- a
  // full-screen flash for the length of an HTTP round trip -- on every
  // single click. Authorisation for the new path is still checked on every
  // render further down; that part is synchronous and needs no network.
  //
  // Expiry is not this effect's job either: the axios interceptor refreshes
  // on 401 for every request the panel makes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let isMounted = true

    const syncAdminProfile = async () => {
      if (!isModuleAuthenticated("admin")) {
        if (isMounted) setStatus("deny")
        return
      }

      if (isMounted) setStatus("checking")

      const accessToken = await ensureValidAccessToken("admin")
      if (!accessToken) {
        if (isMounted) setStatus("deny")
        return
      }

      try {
        const res = await adminAPI.getCurrentAdmin()
        const user =
          res?.data?.data?.user ??
          res?.data?.user ??
          res?.data?.data ??
          res?.data
        const token = localStorage.getItem("admin_accessToken")
        const refreshToken = localStorage.getItem("admin_refreshToken")
        if (token && user) {
          setAuthData("admin", token, user, refreshToken)
          window.dispatchEvent(new Event("adminAuthChanged"))
        }
        if (isMounted) setStatus("ok")
      } catch (error) {
        // Only force logout on auth failure — keep session on network/server blips.
        const statusCode = error?.response?.status
        if (statusCode === 401 || statusCode === 403) {
          clearModuleAuth("admin")
          if (isMounted) setStatus("deny")
          return
        }
        if (isMounted) setStatus("ok")
      }
    }

    syncAdminProfile()

    return () => {
      isMounted = false
    }
  }, [])

  // Only reachable before the first check resolves, i.e. on a cold load of the
  // panel. After that status stays "ok" and navigation never returns here.
  if (status === "checking") {
    return <div className="min-h-screen bg-neutral-100" />
  }

  if (status === "deny") {
    return <Navigate to="/admin/login" state={{ from: location.pathname }} replace />
  }

  const adminUser = getCurrentUser("admin")
  if (!canAccessAdminPath(location.pathname, "view")) {
    return <Navigate to={findFirstAllowedAdminPath(adminUser)} replace />
  }

  return children
}
