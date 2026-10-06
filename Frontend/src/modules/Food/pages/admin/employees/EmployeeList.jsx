import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Search, Shield, Trash2, ToggleLeft, ToggleRight } from "@food/components/admin/theme/icons";
import { adminAPI } from "@food/api";

/** Employees -> List: every sub admin, with access, enable/disable and delete. New ones are added on Employees -> Add new. */
export default function EmployeeList() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getSubAdmins({ search });
      setItems(Array.isArray(res?.data?.data?.items) ? res.data.data.items : []);
    } catch (_e) {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter((it) => [it.name, it.email, it.phone].some((v) => String(v || "").toLowerCase().includes(q)));
  }, [items, search]);

  const toggleStatus = async (item) => {
    await adminAPI.updateSubAdminStatus(item._id, !item.isActive);
    await load();
  };

  const remove = async (item) => {
    if (!window.confirm(`Delete ${item.name || item.email}?`)) return;
    await adminAPI.deleteSubAdmin(item._id);
    await load();
  };

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Sub Admin Management</h1>
          <p className="text-sm text-slate-600 mt-1">Disable or delete sub admins, and choose which sidebar pages each one can see.</p>
        </div>
        <Link to="/admin/food/employees/add" className="inline-flex items-center gap-2 px-4 py-2 bg-black text-white rounded-lg text-sm">
          <Plus className="w-4 h-4" /> Add new
        </Link>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="relative w-full max-w-sm">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="border rounded-lg pl-9 pr-3 py-2 w-full" placeholder="Search sub admins" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button className="px-3 py-2 border rounded-lg text-sm" onClick={load}>Refresh</button>
        </div>

        {loading ? <div className="text-sm text-slate-500">Loading...</div> : (
          <div className="space-y-3">
            {filtered.map((item) => (
              <div key={item._id} className="border border-slate-200 rounded-lg p-3 flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-slate-900">{item.name || "Unnamed"}</p>
                  <p className="text-sm text-slate-600">{item.email} {item.phone ? `• ${item.phone}` : ""}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Link to={`/admin/food/employee-role?id=${item._id}`} className="inline-flex items-center gap-1 px-3 py-2 border rounded-lg text-sm">
                    <Shield className="w-4 h-4" /> Access
                  </Link>
                  <button onClick={() => toggleStatus(item)} className="px-3 py-2 border rounded-lg text-sm inline-flex items-center gap-1">
                    {item.isActive ? <ToggleRight className="w-4 h-4 text-green-600" /> : <ToggleLeft className="w-4 h-4 text-slate-500" />}
                    {item.isActive ? "Disable" : "Enable"}
                  </button>
                  <button onClick={() => remove(item)} className="px-3 py-2 border border-red-200 text-red-600 rounded-lg text-sm inline-flex items-center gap-1">
                    <Trash2 className="w-4 h-4" /> Delete
                  </button>
                </div>
              </div>
            ))}
            {!filtered.length && <div className="text-sm text-slate-500">No sub admins found.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
