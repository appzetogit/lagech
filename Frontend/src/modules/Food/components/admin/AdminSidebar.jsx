import { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { tioIconFor } from "./theme/tioIcons"
import { Link, useLocation, useNavigate } from "react-router-dom"
import {
  Search,
  FileText,
  Calendar,
  Clock,
  Receipt,
  AlertTriangle,
  CheckCircle2,
  MapPin,
  Link as LinkIcon,
  UtensilsCrossed,
  Building2,
  FolderTree,
  Plus,
  Utensils,
  Megaphone,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  X,
  LayoutDashboard,
  Gift,
  DollarSign,
  Image,
  Bell,
  MessageSquare,
  MessagesSquare,
  Mail,
  Users,
  Wallet,
  Award,
  Truck,
  Package,
  CreditCard,
  Settings,
  UserCog,
  User,
  Globe,
  Palette,
  Camera,
  LogIn,
  Database,
  Zap,
  Phone,
  IndianRupee,
  PiggyBank,
  Lock,
  PlusCircle,
  Star,
  Store,
  UserPlus,
  Layers,
  Flame,
  Upload,
  Download,
} from "lucide-react"
import { cn } from "@food/utils/utils"
import { Input } from "@food/components/ui/input"
import { adminSidebarMenu, areaForPath, areaOfEntry } from "@food/utils/adminSidebarMenu"
import { adminAPI } from "@food/api"
import { getCachedSettings, loadBusinessSettings } from "@food/utils/businessSettings"
import { canAccessFeatureSettings, canAccessSuperPowers } from "@food/utils/adminPermissions"
import { canAdminAccess, canSeeMenuPath, isSuperAdmin, resolvePermissionSectionByPath } from "@food/utils/adminRbac"
import lagechLogo from "@food/assets/lagech-logo.png"
const debugLog = (...args) => {}
const debugWarn = (...args) => {}
const debugError = (...args) => {}


// Icon mapping
const iconMap = {
  LayoutDashboard,
  UtensilsCrossed,
  Building2,
  FileText,
  Calendar,
  Clock,
  Receipt,
  AlertTriangle,
  CheckCircle2,
  MapPin,
  Link: LinkIcon,
  FolderTree,
  Plus,
  Utensils,
  Megaphone,
  Gift,
  DollarSign,
  Image,
  Bell,
  MessageSquare,
  MessagesSquare,
  Mail,
  Users,
  Wallet,
  Award,
  Truck,
  Package,
  CreditCard,
  Settings,
  UserCog,
  User,
  Globe,
  Palette,
  Camera,
  LogIn,
  Database,
  Zap,
  Phone,
  IndianRupee,
  PiggyBank,
  Lock,
  PlusCircle,
  Star,
  Store,
  UserPlus,
  Layers,
  Flame,
  Upload,
  Download,
  X,
}

const buildLabelDictionary = (menu = []) => {
  const dictionary = new Map()
  const walkItems = (items = []) => {
    items.forEach((entry) => {
      if (!entry || typeof entry !== "object") return
      const path = String(entry.path || "").trim()
      const label = String(entry.label || "").trim()
      if (path && label && !dictionary.has(path)) {
        dictionary.set(path, label)
      }
      if (entry.type === "section" && Array.isArray(entry.items)) {
        walkItems(entry.items)
      }
      if (entry.type === "expandable" && Array.isArray(entry.subItems)) {
        walkItems(entry.subItems)
      }
    })
  }
  walkItems(menu)
  return dictionary
}

const SIDEBAR_LABEL_BY_PATH = buildLabelDictionary(adminSidebarMenu)

export default function AdminSidebar({ isOpen = false, onClose, onCollapseChange }) {
  const location = useLocation()
  const navigate = useNavigate()
  const navRef = useRef(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [badges, setBadges] = useState({})
  const [restaurantSubscriptionEnabled, setRestaurantSubscriptionEnabled] = useState(true)
  const [codControlEnabled, setCodControlEnabled] = useState(true)
  const [adminAccessSectionEnabled, setAdminAccessSectionEnabled] = useState(true)
  const [rootLandingAndUnregisteredControlEnabled, setRootLandingAndUnregisteredControlEnabled] = useState(true)
  const [canViewFeatureSettings, setCanViewFeatureSettings] = useState(false)
  const [adminUser, setAdminUser] = useState(() => {
    try {
      const raw = localStorage.getItem("admin_user")
      return raw ? JSON.parse(raw) : null
    } catch (_e) {
      return null
    }
  })

  const parseFeatureEnabled = (value, fallback = true) => {
    if (typeof value === "boolean") return value
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase()
      if (normalized === "true") return true
      if (normalized === "false") return false
    }
    if (typeof value === "number") {
      if (value === 1) return true
      if (value === 0) return false
    }
    return fallback
  }

  const deriveMenuLabel = (menuItem, parentLabel = "") => {
    const rawPath = String(menuItem?.path || "").trim()
    const canonical = rawPath ? SIDEBAR_LABEL_BY_PATH.get(rawPath) : ""
    if (canonical) return canonical
    const explicit = String(menuItem?.label || "").trim()
    if (explicit) return explicit
    if (rawPath) {
      const last = rawPath.split("/").filter(Boolean).pop() || ""
      if (last) {
        return last
          .replace(/[-_]+/g, " ")
          .replace(/\b\w/g, (ch) => ch.toUpperCase())
      }
    }
    const parent = String(parentLabel || "").trim()
    return parent || "Untitled"
  }

  useEffect(() => {
    const fetchBadges = async () => {
      try {
        const res = await adminAPI.getSidebarBadges()
        if (res?.data?.success) {
          setBadges(res.data.counts || {})
        }
      } catch (error) {
        debugError("Error fetching sidebar badges:", error)
      }
    }
    fetchBadges()
    const timer = setInterval(fetchBadges, 60000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    setCanViewFeatureSettings(canAccessFeatureSettings(adminUser))

    const loadFeatureSettings = async () => {
      try {
        const res = await adminAPI.getFeatureSettings()
        const rows = Array.isArray(res?.data?.data) ? res.data.data : []
        const feature = rows.find((row) => row.key === "restaurant_subscription")
        const codFeature = rows.find((row) => row.key === "cod_control")
        const adminAccessFeature = rows.find((row) => row.key === "admin_access_section")
        const rootAndUnregisteredFeature = rows.find((row) => row.key === "root_landing_and_unregistered_control")
        if (feature) {
          setRestaurantSubscriptionEnabled((prev) =>
            parseFeatureEnabled(feature.isEnabled, prev)
          )
        }
        if (codFeature) {
          setCodControlEnabled((prev) =>
            parseFeatureEnabled(codFeature.isEnabled, prev)
          )
        }
        if (adminAccessFeature) {
          setAdminAccessSectionEnabled((prev) =>
            parseFeatureEnabled(adminAccessFeature.isEnabled, prev)
          )
        }
        if (rootAndUnregisteredFeature) {
          setRootLandingAndUnregisteredControlEnabled((prev) =>
            parseFeatureEnabled(rootAndUnregisteredFeature.isEnabled, prev)
          )
        }
      } catch (error) {
        // keep default enabled if API fails
      }
    }
    loadFeatureSettings()

    const handleFeatureUpdate = async (event) => {
      const detail = event?.detail || {}
      if (detail.key === "restaurant_subscription") {
        setRestaurantSubscriptionEnabled((prev) =>
          parseFeatureEnabled(detail.isEnabled, prev)
        )
      }
      if (detail.key === "cod_control") {
        setCodControlEnabled((prev) =>
          parseFeatureEnabled(detail.isEnabled, prev)
        )
      }
      if (detail.key === "admin_access_section") {
        setAdminAccessSectionEnabled((prev) =>
          parseFeatureEnabled(detail.isEnabled, prev)
        )
      }
      if (detail.key === "root_landing_and_unregistered_control") {
        setRootLandingAndUnregisteredControlEnabled((prev) =>
          parseFeatureEnabled(detail.isEnabled, prev)
        )
      }
      await loadFeatureSettings()
    }

    window.addEventListener("adminFeatureSettingUpdated", handleFeatureUpdate)
    const handleAuthUpdate = () => {
      try {
        const raw = localStorage.getItem("admin_user")
        const nextAdminUser = raw ? JSON.parse(raw) : null
        setAdminUser(nextAdminUser)
        setCanViewFeatureSettings(canAccessFeatureSettings(nextAdminUser))
      } catch (_e) {
        setAdminUser(null)
        setCanViewFeatureSettings(false)
      }
    }
    window.addEventListener("adminAuthChanged", handleAuthUpdate)
    return () => {
      window.removeEventListener("adminFeatureSettingUpdated", handleFeatureUpdate)
      window.removeEventListener("adminAuthChanged", handleAuthUpdate)
    }
  }, [adminUser])

  const menuData = useMemo(() => {
    // Behaviour comes from explicit keys on each entry (see adminSidebarMenu.js),
    // never from its visible label: gating a section on its heading text meant
    // renaming "SUPER POWERS" would quietly show it to every admin.
    const featureOn = {
      codControl: codControlEnabled,
      restaurantSubscription: restaurantSubscriptionEnabled,
      unregisteredRestaurants: rootLandingAndUnregisteredControlEnabled,
      featureSettings: canViewFeatureSettings,
    }
    const gatePassed = {
      superPowers: canAccessSuperPowers(adminUser),
      adminAccess: adminAccessSectionEnabled,
    }

    // One check for a top-level link, a section item and a sub-item alike, so a
    // feature switch or permission cannot apply in one place and be missed in
    // another.
    const isVisible = (entry) => {
      if (entry.feature && featureOn[entry.feature] === false) return false
      if (entry.requires && !gatePassed[entry.requires]) return false
      if (!entry.path) return true
      if (!canSeeMenuPath(adminUser, entry.path)) return false
      const permissionSection = resolvePermissionSectionByPath(entry.path)
      if (!permissionSection) return isSuperAdmin(adminUser)
      return canAdminAccess(adminUser, permissionSection, "view")
    }

    const mapped = adminSidebarMenu.map((section) => {
      if (section.type === "link") return isVisible(section) ? section : null

      if (section.type !== "section" || !Array.isArray(section.items)) return section
      return {
        ...section,
        items: section.items
          .map((item) => {
            if (!isVisible(item)) return null
            if (item.type === "expandable" && Array.isArray(item.subItems)) {
              const filteredSubItems = item.subItems
                .filter((sub) => Boolean(sub?.path) && isVisible(sub))
                .map((sub) => ({
                  ...sub,
                  label: deriveMenuLabel(sub, item.label),
                }))
              return {
                ...item,
                label: deriveMenuLabel(item),
                subItems: filteredSubItems,
              }
            }
            return item
          })
          .filter((item) => item && (item.type !== "expandable" || (Array.isArray(item.subItems) && item.subItems.length > 0))),
      }
    })
    return mapped.filter((section) => {
      if (!section) return false
      if (section?.type !== "section") return true
      return Array.isArray(section.items) && section.items.length > 0
    })
  }, [adminAccessSectionEnabled, adminUser, canViewFeatureSettings, codControlEnabled, restaurantSubscriptionEnabled, rootLandingAndUnregisteredControlEnabled])

  /** An entry's badge is whatever count its `badge` key names. */
  const getBadgeCount = (entry) => (entry?.badge ? Number(badges[entry.badge] || 0) : 0)
  const [logoUrl, setLogoUrl] = useState(() => getCachedSettings()?.logo?.url || null)
  const [companyName, setCompanyName] = useState(() => getCachedSettings()?.companyName || null)

  // Load business settings logo
  useEffect(() => {
    const loadLogo = async () => {
      try {
        // First check cache
        let cached = getCachedSettings()
        if (cached) {
          if (cached.logo?.url) {
            setLogoUrl(cached.logo.url)
          }
          if (cached.companyName) {
            setCompanyName(cached.companyName)
          }
        }

        // Always try to load fresh data to ensure we have the latest
        const settings = await loadBusinessSettings()
        if (settings) {
          if (settings.logo?.url) {
            setLogoUrl(settings.logo.url)
          }
          if (settings.companyName) {
            setCompanyName(settings.companyName)
          }
        }
      } catch (error) {
        debugError('Error loading logo:', error)
      }
    }

    // Load immediately
    loadLogo()

    // Also try after a small delay to ensure DOM is ready
    const timeoutId = setTimeout(() => {
      loadLogo()
    }, 100)

    // Listen for business settings updates
    const handleSettingsUpdate = () => {
      const cached = getCachedSettings()
      if (cached) {
        if (cached.logo?.url) {
          setLogoUrl(cached.logo.url)
        }
        if (cached.companyName) {
          setCompanyName(cached.companyName)
        }
      }
    }
    window.addEventListener('businessSettingsUpdated', handleSettingsUpdate)

    return () => {
      clearTimeout(timeoutId)
      window.removeEventListener('businessSettingsUpdated', handleSettingsUpdate)
    }
  }, [])

  // Get initial states from consolidated admin_sidebar_state
  const getInitialStates = () => {
    try {
      const saved = localStorage.getItem('admin_sidebar_state')
      if (saved) {
        return JSON.parse(saved)
      }
    } catch (e) {
      debugError('Error loading sidebar state:', e)
    }
    return { isCollapsed: false, expandedSections: {} }
  }

  const [isCollapsed, setIsCollapsed] = useState(() => getInitialStates().isCollapsed)
  const [expandedSections, setExpandedSections] = useState(() => {
    const initialState = getInitialStates().expandedSections
    if (Object.keys(initialState || {}).length > 0) return initialState

    // Generate defaults if empty
    const state = {}
    adminSidebarMenu.forEach((item) => {
      if (item.type === "section") {
        item.items.forEach((subItem) => {
          if (subItem.type === "expandable") {
            state[subItem.label.toLowerCase().replace(/\s+/g, "")] = false
          }
        })
      }
    })
    return state
  })

  // Keep the sidebar where the admin scrolled it. Anything that redraws the
  // menu -- a reload, the menu briefly re-filtering, a page change -- could
  // leave it at the top, so the admin had to scroll back down to the section
  // they were working in after every click.
  const SCROLL_KEY = "admin_sidebar_scroll"
  const saveScroll = () => {
    try {
      if (navRef.current) sessionStorage.setItem(SCROLL_KEY, String(navRef.current.scrollTop))
    } catch (_e) {
      // Storage can be unavailable (private mode); the sidebar still works.
    }
  }
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return undefined
    let saved = 0
    try {
      saved = Number(sessionStorage.getItem(SCROLL_KEY)) || 0
    } catch (_e) {
      saved = 0
    }
    if (saved > 0 && Math.abs(nav.scrollTop - saved) > 1) nav.scrollTop = saved
    // Once more after the page's own render, which can reflow the menu.
    const frame = requestAnimationFrame(() => {
      if (navRef.current && saved > 0 && navRef.current.scrollTop === 0) navRef.current.scrollTop = saved
    })
    return () => cancelAnimationFrame(frame)
  }, [location.pathname])

  // Save states to consolidated localStorage and notify parent
  useEffect(() => {
    try {
      const currentState = JSON.parse(localStorage.getItem('admin_sidebar_state') || '{}')
      localStorage.setItem('admin_sidebar_state', JSON.stringify({
        ...currentState,
        isCollapsed
      }))
      if (onCollapseChange) {
        onCollapseChange(isCollapsed)
      }
    } catch (e) {
      debugError('Error saving sidebar collapsed state:', e)
    }
  }, [isCollapsed, onCollapseChange])

  // Notify parent on initial load
  useEffect(() => {
    if (onCollapseChange) {
      onCollapseChange(isCollapsed)
    }
  }, [])

  const toggleCollapse = () => {
    setIsCollapsed(prev => !prev)
  }

  // expandedSections state is initialized above in getInitialStates consolidation


  // Filter menu items based on search query
  // The top bar picks an area (Food / Users / Transactions & Reports /
  // Settings); the sidebar shows that area only, as the old panel did. The
  // area follows the open page, so a direct link lands in the right one.
  const activeArea = useMemo(() => areaForPath(location.pathname), [location.pathname])

  // The top-bar area links (Users, Transactions & Reports, Settings) only fit
  // from the xl breakpoint up. Below it they are hidden, so the sidebar shows
  // every area — otherwise Settings and the rest could not be reached on a phone.
  const [areaNavVisible, setAreaNavVisible] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(min-width: 1280px)").matches : true
  )
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined
    const mq = window.matchMedia("(min-width: 1280px)")
    const onChange = (e) => setAreaNavVisible(e.matches)
    setAreaNavVisible(mq.matches)
    mq.addEventListener ? mq.addEventListener("change", onChange) : mq.addListener(onChange)
    return () => (mq.removeEventListener ? mq.removeEventListener("change", onChange) : mq.removeListener(onChange))
  }, [])

  useEffect(() => {
    const onSelect = (event) => {
      const area = event?.detail?.area
      if (!area) return
      const visiblePaths = menuData
        .filter((entry) => entry && areaOfEntry(entry) === area)
        .flatMap((entry) => (entry.path ? [entry] : entry.items || []))
        .flatMap((item) => (item.path ? [item.path] : (item.subItems || []).map((sub) => sub.path)))
        .filter(Boolean)
      // The old panel opened Users on its overview page.
      const preferred = { users: "/admin/food/user-overview" }[area]
      const target = visiblePaths.includes(preferred) ? preferred : visiblePaths[0]
      if (target) navigate(target)
    }
    window.addEventListener("admin-area-select", onSelect)
    return () => window.removeEventListener("admin-area-select", onSelect)
  }, [menuData, navigate])

  const filteredMenuData = useMemo(() => {
    if (!searchQuery.trim()) {
      if (!areaNavVisible) {
        // On phones Business Settings sits right under Dashboard, so it is
        // reachable without scrolling through the whole menu.
        const isBusiness = (entry) => entry?.type === "section" && entry.label === "BUSINESS SETTINGS"
        const business = menuData.filter(isBusiness)
        if (!business.length) return menuData
        const rest = menuData.filter((entry) => !isBusiness(entry))
        const firstSection = rest.findIndex((entry) => entry?.type === "section")
        const at = firstSection === -1 ? rest.length : firstSection
        return [...rest.slice(0, at), ...business, ...rest.slice(at)]
      }
      return menuData.filter((entry) => entry && areaOfEntry(entry) === activeArea)
    }

    const query = searchQuery.toLowerCase().trim()
    const filtered = []

    menuData.forEach((item) => {
      if (!item) return
      if (item.type === "link") {
        if (item.label.toLowerCase().includes(query)) {
          filtered.push(item)
        }
      } else if (item.type === "section") {
        const filteredItems = []

        item.items.forEach((subItem) => {
          if (subItem.type === "link") {
            if (subItem.label.toLowerCase().includes(query)) {
              filteredItems.push(subItem)
            }
          } else if (subItem.type === "expandable") {
            const matchesLabel = subItem.label.toLowerCase().includes(query)
            const matchingSubItems = subItem.subItems?.filter(
              (si) => si.label.toLowerCase().includes(query)
            ) || []

            if (matchesLabel || matchingSubItems.length > 0) {
              filteredItems.push({
                ...subItem,
                subItems: matchesLabel ? subItem.subItems : matchingSubItems,
              })
            }
          }
        })

        if (filteredItems.length > 0) {
          filtered.push({
            ...item,
            items: filteredItems,
          })
        }
      }
    })

    return filtered
  }, [menuData, searchQuery, activeArea, areaNavVisible])

  // Auto-expand sections with matches when searching
  useEffect(() => {
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim()

      setExpandedSections((prev) => {
        const newExpandedState = { ...prev }

        menuData.forEach((item) => {
          if (!item) return
          if (item.type === "section") {
            item.items.forEach((subItem) => {
              if (subItem.type === "expandable") {
                const matchesLabel = subItem.label.toLowerCase().includes(query)
                const hasMatchingSubItems = subItem.subItems?.some(
                  (si) => si.label.toLowerCase().includes(query)
                )

                if (matchesLabel || hasMatchingSubItems) {
                  const sectionKey = subItem.label.toLowerCase().replace(/\s+/g, "")
                  newExpandedState[sectionKey] = true
                }
              }
            })
          }
        })

        return newExpandedState
      })
    }
  }, [menuData, searchQuery])

  const isActive = (path, allPaths = []) => {
    const currentPath = location.pathname.replace(/\/+$/, "") || "/"
    const targetPath = String(path || "").replace(/\/+$/, "") || "/"
    const matchesPath = (candidatePath) =>
      currentPath === candidatePath || currentPath.startsWith(`${candidatePath}/`)

    if (targetPath === "/admin" || targetPath === "/admin/food") {
      return currentPath === targetPath
    }

    // For subItems, check if this is the most specific match
    if (allPaths.length > 0) {
      // Sort paths by length (longest first) to find most specific match
      const sortedPaths = [...allPaths].sort((a, b) => b.length - a.length)
      const bestMatch = sortedPaths.find((candidatePath) =>
        matchesPath(String(candidatePath || "").replace(/\/+$/, "") || "/")
      )
      return (String(bestMatch || "").replace(/\/+$/, "") || "/") === targetPath
    }

    return matchesPath(targetPath)
  }

  useEffect(() => {
    try {
      const currentState = JSON.parse(localStorage.getItem('admin_sidebar_state') || '{}')
      localStorage.setItem('admin_sidebar_state', JSON.stringify({
        ...currentState,
        expandedSections
      }))
    } catch (e) {
      debugError('Error saving sidebar state:', e)
    }
  }, [expandedSections])

  const toggleSection = (sectionKey) => {
    setExpandedSections((prev) => {
      const isCurrentlyOpen = Boolean(prev[sectionKey])

      // Accordion behavior:
      // 1) If current section is open -> close it.
      // 2) If current section is closed -> open it and close all others.
      if (isCurrentlyOpen) {
        return {
          ...prev,
          [sectionKey]: false,
        }
      }

      // Built from prev's keys, but the clicked section is set explicitly: prev
      // comes from localStorage, saved under an older menu, and a section that
      // did not exist then was never a key -- so it could not be opened at all.
      const next = {}
      Object.keys(prev).forEach((key) => {
        next[key] = false
      })
      next[sectionKey] = true
      return next
    })
  }

  const renderMenuItem = (item, index, isInSection = false) => {
    const getDisplayLabel = (menuItem) => {
      const rawLabel = String(menuItem?.label || "").trim()
      if (rawLabel) return rawLabel
      const path = String(menuItem?.path || "").trim()
      if (!path) return "Untitled"
      const last = path.split("/").filter(Boolean).pop() || "item"
      return last
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (ch) => ch.toUpperCase())
    }

    if (item.type === "link") {
      const displayLabel = getDisplayLabel(item)
      return (
        <Link
          key={item.path || index}
          to={item.path}
          onClick={() => {
            if (window.innerWidth < 1024 && onClose) {
              onClose()
            }
          }}
          className={cn(
            "flex items-center gap-3 px-3 py-2 rounded-[5px] transition-colors duration-200 menu-item-animate text-left text-sm font-normal",
            isActive(item.path)
              ? "bg-white/10 text-[#5AFFBA]"
              : "text-[#E9F3FF] hover:text-[#5AFFBA]",
            isCollapsed && "justify-center px-2"
          )}
          style={{ animationDelay: `${index * 0.05}s` }}
          title={isCollapsed ? displayLabel : undefined}
        >
          <i className={`tio-${tioIconFor(item)} tio-nav-icon text-[#5AFFBA]`} aria-hidden="true" />
          {!isCollapsed && (
            <div className="flex-1 flex items-center justify-between overflow-hidden">
              <span className="text-left truncate">
                {displayLabel}
              </span>
              {getBadgeCount(item) > 0 && (
                <span className="shrink-0 bg-[#5AFFBA]/15 text-[#5AFFBA] ring-1 ring-[#5AFFBA]/40 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ml-1 min-w-[18px] text-center">
                  {getBadgeCount(item) > 99 ? "99+" : getBadgeCount(item)}
                </span>
              )}
            </div>
          )}
          {isCollapsed && getBadgeCount(item) > 0 && (
            <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-600 rounded-full border-2 border-[#005555]" />
          )}
        </Link>
      )
    }

    if (item.type === "expandable") {
      const sectionKey = item.label.toLowerCase().replace(/\s+/g, "")
      const isExpanded = expandedSections[sectionKey] || false

      if (isCollapsed) {
        return (
          <div key={index} className="menu-item-animate" style={{ animationDelay: `${index * 0.05}s` }}>
            <button
              onClick={() => toggleSection(sectionKey)}
              className={cn(
                "w-full flex items-center justify-center px-2 py-2 rounded-lg transition-all duration-300 ease-out text-sm font-medium",
                "text-white hover:bg-white/5"
              )}
              title={item.label}
            >
              <div className="relative">
                <i className={`tio-${tioIconFor(item)} tio-nav-icon text-[#5AFFBA]`} aria-hidden="true" />
                {getBadgeCount(item) > 0 && (
                  <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-600 rounded-full border-2 border-[#005555]" />
                )}
              </div>
            </button>
          </div>
        )
      }

      return (
        <div key={index} className="menu-item-animate" style={{ animationDelay: `${index * 0.05}s` }}>
          <button
            onClick={() => toggleSection(sectionKey)}
            className={cn(
              "w-full flex items-center justify-between gap-2 px-3 py-2 rounded-[5px] transition-colors duration-200 text-sm font-normal text-left",
              "text-[#E9F3FF] hover:text-[#5AFFBA]"
            )}
          >
            <div className="flex items-center gap-2.5 text-left flex-1 min-w-0">
              <i className={`tio-${tioIconFor(item)} tio-nav-icon text-[#5AFFBA]`} aria-hidden="true" />
              <span className="text-left truncate">{item.label}</span>
              {getBadgeCount(item) > 0 && (
                <span className="shrink-0 bg-[#5AFFBA]/15 text-[#5AFFBA] ring-1 ring-[#5AFFBA]/40 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ml-1 min-w-[18px] text-center">
                  {getBadgeCount(item) > 99 ? "99+" : getBadgeCount(item)}
                </span>
              )}
            </div>
            <div className="transition-transform duration-300 shrink-0" style={{ transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
              <ChevronDown className="w-4 h-4 shrink-0 text-[#E9F3FF]/70" />
            </div>
          </button>
          {isExpanded && item.subItems && (
            <div className="mt-1 space-y-0.5 pl-6 submenu-animate overflow-hidden">
              {item.subItems.map((subItem, subIndex) => {
                const allSubPaths = item.subItems.map(si => si.path)
                const isSubItemActive = isActive(subItem.path, allSubPaths)
                const displaySubLabel = deriveMenuLabel(
                  subItem,
                  item.subItems.length === 1 ? item.label : ""
                )
                return (
                  <Link
                    key={subItem.path || `${index}-${subIndex}`}
                    to={subItem.path}
                    onClick={() => {
                      if (window.innerWidth < 1024 && onClose) {
                        onClose()
                      }
                    }}
                    className={cn(
                      "w-full grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-1.5 rounded-[5px] transition-colors duration-200 text-sm font-normal text-left",
                      isSubItemActive
                        ? "bg-white/10 text-[#5AFFBA]"
                        : "text-[#E9F3FF] hover:text-[#5AFFBA]"
                    )}
                    style={{ animationDelay: `${subIndex * 0.03}s` }}
                  >
                    <span className={cn(
                      "w-1.5 h-1.5 rounded-full shrink-0 transition-all duration-300",
                      isSubItemActive ? "bg-[#5AFFBA]" : "bg-[#E9F3FF]/60"
                    )}></span>
                    <span
                      className={cn(
                        "block text-left text-[13px] leading-5",
                        isSubItemActive ? "text-[#5AFFBA]" : "text-[#E9F3FF]"
                      )}
                    >
                      {String(displaySubLabel || subItem?.label || subItem?.path || "Menu item")}
                    </span>
                    {getBadgeCount(subItem) > 0 && (
                      <span className="shrink-0 bg-[#5AFFBA]/15 text-[#5AFFBA] ring-1 ring-[#5AFFBA]/40 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ml-1 min-w-[18px] text-center">
                        {getBadgeCount(subItem) > 99 ? "99+" : getBadgeCount(subItem)}
                      </span>
                    )}
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      )
    }

    return null
  }

  return (
    <>
      <style>{`
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateX(-10px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        
        @keyframes expandDown {
          from {
            opacity: 0;
            max-height: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            max-height: 500px;
            transform: translateY(0);
          }
        }
        
        .menu-item-animate {
          animation: slideIn 0.3s ease-out forwards;
        }
        
        .submenu-animate {
          animation: expandDown 0.3s ease-out forwards;
        }
        
        .admin-sidebar-scroll {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
        }
        
        .admin-sidebar-scroll::-webkit-scrollbar {
          width: 2px;
        }
        .admin-sidebar-scroll::-webkit-scrollbar-track {
          background: rgba(17, 24, 39, 0.4);
        }
        .admin-sidebar-scroll::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.2);
          border-radius: 10px;
          transition: background 0.2s ease;
        }
        .admin-sidebar-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.35);
        }
        .admin-sidebar-scroll:hover::-webkit-scrollbar {
          width: 6px;
        }
        .admin-sidebar-scroll {
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.25) rgba(17, 24, 39, 0.4);
        }
      `}</style>
      <div
        className={cn(
          "bg-[#005555] h-screen fixed left-0 top-0 z-50 flex flex-col overflow-hidden",
          "transform transition-all duration-300 ease-in-out",
          "lg:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full",
          isCollapsed ? "w-20" : "w-[260px]"
        )}
      >
        {/* Header with Logo and Brand */}
        <div className="shrink-0 bg-[#005555] animate-[fadeIn_0.4s_ease-out]">
          <div className="flex items-center justify-between h-[60px] px-4 bg-white">
            {!isCollapsed && (
              <div className="flex items-center gap-2 animate-[slideIn_0.3s_ease-out]">
                <div className="w-24 h-12 rounded-lg flex items-center justify-center shadow-black/20">
                  {logoUrl ? (
                    <img
                      src={logoUrl || lagechLogo}
                      alt={companyName || "Company"}
                      className="w-24 h-10 object-contain"
                      loading="lazy"
                      onError={(e) => {
                        if (e.target.src !== lagechLogo) {
                          e.target.src = lagechLogo
                        }
                      }}
                    />
                  ) : companyName ? (
                    <span className="text-xs font-semibold text-white px-2 truncate">
                      {companyName}
                    </span>
                  ) : (
                    <img src={lagechLogo} alt="Company" className="w-24 h-10 object-contain" loading="lazy" />
                  )}
                </div>
              </div>
            )}
            {isCollapsed && (
              <div className="w-full flex items-center justify-center">
                <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center shadow-lg shadow-black/20 ring-1 ring-white/10">
                  {logoUrl || companyName ? (
                    <img
                      src={logoUrl || lagechLogo}
                      alt={companyName || "Company"}
                      className="w-10 h-10 object-contain"
                      loading="lazy"
                      onError={(e) => {
                        if (e.target.src !== lagechLogo) {
                          e.target.src = lagechLogo
                        }
                      }}
                    />
                  ) : (
                    <img src={lagechLogo} alt="Company" className="w-10 h-10 object-contain" loading="lazy" />
                  )}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={toggleCollapse}
                className="text-slate-400 hover:text-slate-700 transition-colors duration-200 p-1.5 rounded-md"
                title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                {isCollapsed ? (
                  <ChevronRight className="w-4 h-4" />
                ) : (
                  <ChevronLeft className="w-4 h-4" />
                )}
              </button>
              <button
                onClick={onClose}
                className="lg:hidden text-slate-400 hover:text-slate-700 transition-colors duration-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Admin Panel Label */}

          {/* Search Bar */}
          {!isCollapsed && (
            <div className="relative mx-[10px] mt-5 mb-1 animate-[slideIn_0.4s_ease-out_0.2s_both]">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[#99A7BA] w-4 h-4 z-10" />
              <Input
                type="text"
                placeholder="Search Menu..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className={cn(
                  "w-full h-11 pl-9 py-2 bg-[rgba(162,200,200,0.1)] border border-[#E7EAF3]/70 rounded-[5px] text-sm text-white placeholder:text-[#99A7BA] focus:outline-none focus:border-[#5AFFBA] transition-colors duration-200 text-left",
                  searchQuery ? "pr-9" : "pr-3"
                )}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-neutral-200 hover:text-white transition-all duration-200 hover:scale-110 z-10"
                  aria-label="Clear search"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Navigation Menu */}
        <nav ref={navRef} onScroll={saveScroll} className="admin-sidebar-scroll flex-1 min-h-0 overflow-y-auto overscroll-y-contain px-3 py-3 space-y-2">
          {filteredMenuData.length === 0 && searchQuery.trim() ? (
            <div className="px-3 py-12 text-left animate-[fadeIn_0.4s_ease-out]">
              <p className="text-neutral-100 text-sm font-medium text-left">No menu items found</p>
              <p className="text-neutral-300 text-sm mt-2 text-left">Try a different search term</p>
            </div>
          ) : (
            filteredMenuData.map((item, index) => {
              if (!item) return null
              if (item.type === "link") {
                return renderMenuItem(item, item.path || item.label || `link-${index}`)
              }

              if (item.type === "section") {
                const sectionStableKey = `section-${item.label || index}`
                return (
                  <div
                    key={sectionStableKey}
                    className={cn(
                      index > 0 ? "mt-5" : "",
                      "animate-[fadeIn_0.4s_ease-out]"
                    )}
                    style={{ animationDelay: `${index * 0.1}s` }}
                  >
                    {!isCollapsed && (
                      <div className="px-3 pb-2">
                        <span className="text-[#99A7BA] font-semibold text-xs uppercase tracking-[0.5px] text-left">
                          {item.label}
                        </span>
                      </div>
                    )}
                    <div className="space-y-1">
                      {item.items.map((subItem, subIndex) =>
                        renderMenuItem(
                          subItem,
                          subItem?.path || subItem?.label || `${sectionStableKey}-item-${subIndex}`,
                          true
                        )
                      )}
                    </div>
                  </div>
                )
              }

              return null
            })
          )}
        </nav>
      </div>
    </>
  )
}
