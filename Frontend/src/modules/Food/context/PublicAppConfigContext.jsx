import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLocation } from "react-router-dom";
import {
  getPublicAppConfigSnapshot,
  invalidatePublicAppConfig,
  loadCorePublicAppConfig,
  loadLandingSettingsForZone,
  loadUserHomePublicConfig,
} from "@food/services/publicAppConfig";
import {
  applyModulePowerScanning,
  setCachedSettings,
} from "@food/utils/businessSettings";

const PublicAppConfigContext = createContext(null);

const resolveModuleFromPath = (pathname = "") => {
  if (pathname.startsWith("/food/restaurant")) return "restaurant";
  if (pathname.startsWith("/food/delivery")) return "delivery";
  // The admin panel had no branch of its own, so it fell through to "user"
  // and was painted with the customer app's theme colour.
  // applyModulePowerScanning rewrites every bg-teal-*/emerald-*/green-*
  // class with !important, and the sidebar is bg-teal-800 -- so whatever
  // colour the customer app was set to became the admin chrome. Admin has a
  // fixed brand identity and is not themeable from Power Scanning.
  if (pathname.startsWith("/admin")) return "admin";
  return "user";
};

export function PublicAppConfigProvider({ children }) {
  const location = useLocation();
  const [config, setConfig] = useState(() => getPublicAppConfigSnapshot());
  const [loading, setLoading] = useState(true);

  const refreshCore = useCallback(async (force = false) => {
    if (force) invalidatePublicAppConfig();
    const snapshot = await loadCorePublicAppConfig({ force });
    if (snapshot.businessSettings) {
      setCachedSettings(snapshot.businessSettings);
    }
    setConfig(snapshot);
    return snapshot;
  }, []);

  const refreshUserHome = useCallback(async (force = false) => {
    if (force) invalidatePublicAppConfig();
    const snapshot = await loadUserHomePublicConfig({ force });
    setConfig(snapshot);
    return snapshot;
  }, []);

  // `options` carries the customer coordinates when there are any. The rail
  // can be ordered nearest-first, and without them the server has nothing to
  // measure from and falls back to the admin's order.
  const refreshLanding = useCallback(async (zoneId, force = false, options = {}) => {
    const landing = await loadLandingSettingsForZone(zoneId, { force, ...options });
    setConfig(getPublicAppConfigSnapshot());
    return landing;
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const snapshot = await loadCorePublicAppConfig();
        if (cancelled) return;
        if (snapshot.businessSettings) {
          setCachedSettings(snapshot.businessSettings);
          applyModulePowerScanning(
            resolveModuleFromPath(window.location?.pathname || ""),
            snapshot.businessSettings,
          );
        }
        setConfig(snapshot);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const handleSettingsUpdate = () => {
      void refreshCore(true).then((snapshot) => {
        if (snapshot?.businessSettings) {
          applyModulePowerScanning(
            resolveModuleFromPath(window.location?.pathname || ""),
            snapshot.businessSettings,
          );
        }
      });
    };

    window.addEventListener("businessSettingsUpdated", handleSettingsUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener("businessSettingsUpdated", handleSettingsUpdate);
    };
  }, [refreshCore]);

  useEffect(() => {
    const moduleName = resolveModuleFromPath(location.pathname);
    const cached = config.businessSettings;
    if (cached) {
      applyModulePowerScanning(moduleName, cached);
    }
  }, [location.pathname, config.businessSettings]);

  const value = useMemo(
    () => ({
      ...config,
      loading,
      refreshCore,
      refreshUserHome,
      refreshLanding,
    }),
    [config, loading, refreshCore, refreshUserHome, refreshLanding],
  );

  return (
    <PublicAppConfigContext.Provider value={value}>
      {children}
    </PublicAppConfigContext.Provider>
  );
}

export function usePublicAppConfig() {
  const context = useContext(PublicAppConfigContext);
  if (!context) {
    throw new Error("usePublicAppConfig must be used within PublicAppConfigProvider");
  }
  return context;
}

export function usePublicAppConfigOptional() {
  return useContext(PublicAppConfigContext);
}
