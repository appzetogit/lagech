import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { adminAPI } from "@food/api";
import { toast } from "sonner";
import SidebarAccessPicker, {
  accessLevelFromSubAdmin,
  pagesFromSubAdmin,
  permissionsForPages,
} from "./SidebarAccessPicker";
import RoleSelect from "./RoleSelect";

/** One sub-admin's access: the sidebar pages they see, and whether they can change things. */
export default function EmployeeRole() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const subAdminId = searchParams.get("id");
  const [subAdmin, setSubAdmin] = useState(null);
  const [pages, setPages] = useState(new Set());
  const [level, setLevel] = useState("full");
  const [roleId, setRoleId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!subAdminId) return;
    setLoading(true);
    adminAPI
      .getSubAdminById(subAdminId)
      .then((res) => {
        const sa = res?.data?.data?.subAdmin || null;
        setSubAdmin(sa);
        setPages(pagesFromSubAdmin(sa));
        setLevel(accessLevelFromSubAdmin(sa));
        setRoleId(sa?.roleId || "");
      })
      .catch(() => setSubAdmin(null))
      .finally(() => setLoading(false));
  }, [subAdminId]);

  const save = async () => {
    if (!subAdmin) return;
    setSaving(true);
    try {
      const menuPaths = [...pages];
      if (roleId) {
        await adminAPI.updateSubAdminPermissions(subAdminId, {}, undefined, roleId);
        toast.success("Saved: this sub admin now follows the role");
        navigate("/admin/food/employees");
        return;
      }
      await adminAPI.updateSubAdminPermissions(subAdminId, permissionsForPages(menuPaths, level), menuPaths);
      toast.success(
        menuPaths.length
          ? `Access saved: ${menuPaths.length} page${menuPaths.length === 1 ? "" : "s"}, ${level === "view" ? "view only" : "full access"}. They see it on their next page load.`
          : "Access saved: this sub admin now has no pages",
      );
      navigate("/admin/food/employees");
    } catch (error) {
      // The interceptor reports why; staying keeps the selection.
    } finally {
      setSaving(false);
    }
  };

  if (!subAdminId) {
    return <div className="p-6 text-sm text-red-600">Missing sub-admin id in URL. Open from Employees.</div>;
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h1 className="text-2xl font-bold text-slate-900">Sub Admin Access</h1>
        <p className="text-sm text-slate-600 mt-1">{subAdmin ? `${subAdmin.name || "Unnamed"} (${subAdmin.email})` : "Loading sub-admin..."}</p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5">
        {loading ? (
          <p className="text-sm text-slate-500">Loading access...</p>
        ) : (
          <div className="space-y-4">
            <RoleSelect value={roleId} onChange={setRoleId} />
            {roleId ? (
              <p className="text-sm text-slate-600">Their pages and access come from the role, and change when the role does.</p>
            ) : (
              <SidebarAccessPicker selected={pages} onChange={setPages} level={level} onLevelChange={setLevel} />
            )}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <button disabled={!subAdmin || saving} onClick={save} className="px-4 py-2 bg-black text-white rounded-lg disabled:opacity-60">
          {saving ? "Saving..." : "Save access"}
        </button>
        <button type="button" onClick={() => navigate("/admin/food/employees")} className="px-4 py-2 border rounded-lg">
          Cancel
        </button>
      </div>
    </div>
  );
}
