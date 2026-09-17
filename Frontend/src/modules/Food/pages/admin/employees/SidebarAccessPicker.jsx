import { useMemo } from "react"
import { adminSidebarMenu } from "@food/utils/adminSidebarMenu"
import { ADMIN_ACTIONS, resolvePermissionSectionByPath } from "@food/utils/adminRbac"

/**
 * Choosing what a sub-admin sees, one sidebar page at a time.
 *
 * The tree is the sidebar itself, so a page added to the menu appears here with
 * no second list to keep in step. A page with no permission section behind it
 * (and sub-admin management) is super-admin only on the server, so it is shown
 * but cannot be ticked -- a box that grants nothing is worse than no box.
 */

const SUPER_ADMIN_ONLY = new Set(["sub_admin_management"])

/** The sidebar as groups of tickable pages. */
export function buildAccessTree(menu = adminSidebarMenu) {
  const groups = []
  let loose = null
  const leaf = (entry, parentLabel = "") => {
    const section = resolvePermissionSectionByPath(entry.path)
    return {
      path: entry.path,
      label: entry.label || entry.path,
      parentLabel,
      section,
      grantable: Boolean(section) && !SUPER_ADMIN_ONLY.has(section),
    }
  }
  for (const entry of menu) {
    if (entry?.type === "link" && entry.path) {
      if (!loose) {
        loose = { label: "General", pages: [] }
        groups.push(loose)
      }
      loose.pages.push(leaf(entry))
    }
    if (entry?.type === "section") {
      const pages = []
      for (const item of entry.items || []) {
        if (item.path) pages.push(leaf(item))
        for (const sub of item.subItems || []) {
          if (sub.path) pages.push(leaf(sub, item.label))
        }
      }
      if (pages.length) groups.push({ label: entry.label, pages })
    }
  }
  return groups
}

const VIEW_ONLY_ACTIONS = ["view", "export"]

/**
 * The section permissions the API needs for the chosen pages. Full access
 * grants every action on those sections; view only lets them look and export.
 */
export function permissionsForPages(paths = [], level = "full") {
  const actions = level === "view" ? VIEW_ONLY_ACTIONS : [...ADMIN_ACTIONS]
  const permissions = {}
  for (const path of paths) {
    const section = resolvePermissionSectionByPath(path)
    if (section && !SUPER_ADMIN_ONLY.has(section)) permissions[section] = [...actions]
  }
  return permissions
}

/**
 * The pages ticked for an existing sub-admin. One who was given sections
 * before pages could be chosen gets every page those sections cover, so
 * opening their access and saving changes nothing they could already see.
 */
export function pagesFromSubAdmin(subAdmin, tree = buildAccessTree()) {
  const chosen = Array.isArray(subAdmin?.menuPaths) ? subAdmin.menuPaths : []
  if (chosen.length) return new Set(chosen)
  const permissions = subAdmin?.permissions || {}
  const pages = new Set()
  for (const group of tree) {
    for (const page of group.pages) {
      if (page.grantable && (permissions[page.section] || []).includes("view")) pages.add(page.path)
    }
  }
  return pages
}

export function accessLevelFromSubAdmin(subAdmin) {
  const permissions = subAdmin?.permissions || {}
  const any = Object.values(permissions).some((actions) => (actions || []).length)
  if (!any) return "full"
  return Object.values(permissions).some((actions) => (actions || []).some((a) => ["create", "edit", "delete"].includes(a)))
    ? "full"
    : "view"
}

export default function SidebarAccessPicker({ selected, onChange, level, onLevelChange }) {
  const tree = useMemo(() => buildAccessTree(), [])
  const grantableCount = tree.reduce((n, g) => n + g.pages.filter((p) => p.grantable).length, 0)

  const setPages = (paths, on) => {
    const next = new Set(selected)
    for (const path of paths) {
      if (on) next.add(path)
      else next.delete(path)
    }
    onChange(next)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-800">Sidebar access</p>
          <p className="text-xs text-slate-500">
            Tick the pages this sub admin can see. Everything else is hidden from their sidebar and closed to them.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden text-xs" role="radiogroup" aria-label="Access level">
            {[
              ["full", "Full access"],
              ["view", "View only"],
            ].map(([key, text]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={level === key}
                onClick={() => onLevelChange(key)}
                className={`px-3 py-1.5 font-medium ${level === key ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              >
                {text}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPages(tree.flatMap((g) => g.pages.filter((p) => p.grantable).map((p) => p.path)), selected.size < grantableCount)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            {selected.size < grantableCount ? "Select all" : "Clear all"}
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {tree.map((group) => {
          const grantable = group.pages.filter((p) => p.grantable)
          const ticked = grantable.filter((p) => selected.has(p.path)).length
          return (
            <fieldset key={group.label} className="rounded-lg border border-slate-200 p-3">
              <legend className="px-1">
                <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-700">
                  <input
                    type="checkbox"
                    checked={grantable.length > 0 && ticked === grantable.length}
                    ref={(el) => {
                      if (el) el.indeterminate = ticked > 0 && ticked < grantable.length
                    }}
                    disabled={!grantable.length}
                    onChange={(e) => setPages(grantable.map((p) => p.path), e.target.checked)}
                  />
                  {group.label}
                </label>
              </legend>
              <div className="mt-1 space-y-1">
                {group.pages.map((page) => (
                  <label
                    key={page.path}
                    className={`flex items-center gap-2 text-sm ${page.grantable ? "text-slate-700 cursor-pointer" : "text-slate-400"}`}
                    title={page.grantable ? page.path : "Only the main admin can use this page"}
                  >
                    <input
                      type="checkbox"
                      checked={page.grantable && selected.has(page.path)}
                      disabled={!page.grantable}
                      onChange={(e) => setPages([page.path], e.target.checked)}
                    />
                    <span className="truncate">
                      {page.parentLabel ? <span className="text-slate-400">{page.parentLabel} › </span> : null}
                      {page.label}
                    </span>
                    {!page.grantable && <span className="text-[10px] uppercase text-slate-400">Main admin only</span>}
                  </label>
                ))}
              </div>
            </fieldset>
          )
        })}
      </div>
    </div>
  )
}
