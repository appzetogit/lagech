import { useState, useEffect, useRef, Suspense } from "react"
import { Outlet, useLocation } from "react-router-dom"
import AdminSidebar from "./AdminSidebar"
import AdminNavbar from "./AdminNavbar"
import { API_BASE_URL } from "@food/api/config"
const debugLog = (...args) => {}
const debugWarn = (...args) => {}
const debugError = (...args) => {}


/**
 * Fills the content area while a route chunk loads.
 *
 * Deliberately not the shared <Loader />: that renders AppShellSkeleton, a
 * full-screen mock of the customer storefront -- header, hero, restaurant
 * grid -- which is not what is arriving and looks like the wrong app for the
 * moment it is on screen.
 */
function AdminContentLoader() {
  return (
    <div
      role="status"
      aria-label="Loading page"
      className="flex h-full min-h-[60vh] w-full items-center justify-center"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-teal-700" />
    </div>
  );
}

export default function AdminLayout() {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const mainContentRef = useRef(null);

  // Safely enforce light mode for the Admin panel to prevent User dark mode bleeding
  useEffect(() => {
    document.documentElement.classList.remove('dark');
    return () => {
      const savedTheme = localStorage.getItem('appTheme') || 'light';
      if (savedTheme === 'dark') {
        document.documentElement.classList.add('dark');
      }
    };
  }, []);

  // Get initial collapsed state from localStorage to set initial margin
  useEffect(() => {
    try {
      const saved = localStorage.getItem('admin_sidebar_state')
      if (saved !== null) {
        const state = JSON.parse(saved)
        if (state && typeof state.isCollapsed !== 'undefined') {
          setIsSidebarCollapsed(state.isCollapsed)
        }
      }
    } catch (e) {
      debugError('Error loading sidebar collapsed state:', e)
    }
  }, [])

  const handleCollapseChange = (collapsed) => {
    setIsSidebarCollapsed(collapsed)
  }

  // Ensure each admin route opens from top of the scrollable content area.
  useEffect(() => {
    if (mainContentRef.current) {
      mainContentRef.current.scrollTop = 0;
    }
    if (typeof window !== "undefined") {
      window.scrollTo(0, 0);
    }
  }, [location.pathname]);

  return (
    <div className="h-screen bg-neutral-200 flex overflow-hidden">
      {/* Mobile Overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-gray-900/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <AdminSidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onCollapseChange={handleCollapseChange}
      />

      {/* Main Content Area */}
      <div className={`
        flex-1 flex min-h-0 flex-col transition-all duration-300 ease-in-out min-w-0
        ${isSidebarCollapsed ? 'lg:ml-20' : 'lg:ml-80'}
      `}>
        {/* Top Navbar */}
        <AdminNavbar onMenuClick={() => setSidebarOpen(!sidebarOpen)} />

        {/* Backend disconnected banner */}
        {!API_BASE_URL && (
          <div className="w-full bg-amber-100 border-b border-amber-300 px-4 py-2 text-center text-sm text-amber-900">
            Backend disconnected. Data is not live.
          </div>
        )}

        {/* Page Content */}
        <main
          ref={mainContentRef}
          className="flex-1 min-h-0 w-full max-w-full overflow-x-hidden overflow-y-auto bg-neutral-100"
        >
          {/*
            The router lazy-loads every admin route, and its Suspense sits
            around the whole <Routes> tree -- so while a route chunk was
            fetching, React unmounted the sidebar and navbar along with the
            page and put the loader where the entire panel had been. Clicking
            any sidebar item flashed the whole screen white, which reads as the
            panel reloading.

            This boundary is nearer the change, so a chunk load only suspends
            the content area. The chrome around it stays mounted and the
            clicked item stays highlighted while the page arrives.
          */}
          <Suspense fallback={<AdminContentLoader />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
