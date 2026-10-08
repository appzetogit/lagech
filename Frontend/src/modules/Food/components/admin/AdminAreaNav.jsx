import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { ADMIN_AREAS, areaForPath, entriesOfArea } from "@food/utils/adminSidebarMenu"

/** Ask the sidebar to open an area; it navigates to the first page this admin may see there. */
const selectArea = (area) => window.dispatchEvent(new CustomEvent("admin-area-select", { detail: { area } }))

/** Settings pages, flattened for the dropdown: one row per page, grouped by section. */
function useSettingsLinks() {
  return useMemo(
    () =>
      entriesOfArea("settings").map((section) => ({
        label: section.label,
        links: (section.items || []).flatMap((item) =>
          item.type === "expandable"
            ? (item.subItems || []).map((sub) => ({ label: sub.label, path: sub.path }))
            : item.path
              ? [{ label: item.label, path: item.path }]
              : []
        ),
      })),
    []
  )
}

/**
 * The previous panel's top links: Users, Transactions & Reports, Settings (a
 * dropdown of every settings page) and Dispatch Management. Picking one shows
 * that area's menu in the sidebar.
 */
export default function AdminAreaNav() {
  const location = useLocation()
  const navigate = useNavigate()
  const active = areaForPath(location.pathname)
  const onDispatch = location.pathname.startsWith("/admin/food/dispatch")
  const settingsGroups = useSettingsLinks()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef(null)

  useEffect(() => {
    if (!settingsOpen) return undefined
    const close = (event) => {
      if (!settingsRef.current?.contains(event.target)) setSettingsOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [settingsOpen])

  useEffect(() => setSettingsOpen(false), [location.pathname])

  const linkClass = (isActive) =>
    `inline-flex items-center gap-2 rounded-[5px] px-3 py-2 text-[15px] font-medium transition-colors ${
      isActive ? "bg-[#00868F]/10 text-[#00868F]" : "text-[#00868F] hover:bg-[#00868F]/5"
    }`

  const [, users, transactions, settings] = ADMIN_AREAS

  return (
    <nav className="hidden xl:flex items-center gap-1" aria-label="Admin areas">
      <button type="button" className={linkClass(active === "users" && !onDispatch)} onClick={() => selectArea("users")}>
        <i className={`tio-${users.icon} text-lg`} />
        {users.label}
      </button>
      <button
        type="button"
        className={linkClass(active === "transactions" && !onDispatch)}
        onClick={() => selectArea("transactions")}
      >
        <i className={`tio-${transactions.icon} text-lg`} />
        {transactions.label}
      </button>

      <div className="relative" ref={settingsRef}>
        <button
          type="button"
          className={linkClass(active === "settings" && !onDispatch)}
          onClick={() => setSettingsOpen((open) => !open)}
          aria-expanded={settingsOpen}
        >
          <i className={`tio-${settings.icon} text-lg`} />
          {settings.label}
          <i className={`tio-chevron-down text-sm transition-transform ${settingsOpen ? "rotate-180" : ""}`} />
        </button>
        {settingsOpen && (
          <div className="absolute left-0 top-full z-50 mt-2 max-h-[70vh] w-[520px] overflow-y-auto rounded-xl border border-[#E7EAF3] bg-white p-4 shadow-[0_6px_24px_rgba(140,152,164,0.25)]">
            <div className="grid grid-cols-2 gap-x-6 gap-y-4">
              {settingsGroups.map((group) => (
                <div key={group.label}>
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.5px] text-[#99A7BA]">{group.label}</p>
                  <ul className="space-y-0.5">
                    {group.links.map((link) => (
                      <li key={link.path}>
                        <button
                          type="button"
                          onClick={() => navigate(link.path)}
                          className={`w-full rounded-[5px] px-2 py-1.5 text-left text-sm transition-colors hover:bg-[#F9FAFC] ${
                            location.pathname === link.path ? "font-semibold text-[#00868F]" : "text-[#334257]"
                          }`}
                        >
                          {link.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <button type="button" className={linkClass(onDispatch)} onClick={() => navigate("/admin/food/dispatch")}>
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#00868F] text-white">
          <i className="tio-bike text-sm" />
        </span>
        Dispatch Management
      </button>
    </nav>
  )
}
