import { useState } from "react";
import { toast } from "sonner";
import { Plus } from "@food/components/admin/theme/icons";
import { adminAPI } from "@food/api";
import SidebarAccessPicker, { permissionsForPages } from "./SidebarAccessPicker";
import RoleSelect from "./RoleSelect";

const SUBADMIN_EMAIL_REGEX = /^(?!.*\.\.)([A-Za-z0-9]+[._%+-]?)*[A-Za-z0-9]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}$/;
const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;
const NAME_REGEX = /^[A-Za-z]+(?:\s+[A-Za-z]+)*$/;

const hasSuspiciousEmailTld = (emailValue) => {
  const email = String(emailValue || "").trim().toLowerCase();
  const domain = email.split("@")[1] || "";
  const tld = domain.split(".").pop() || "";
  if (!tld) return true;
  if (/^com+$/i.test(tld) && tld !== "com") return true;
  if (/(.)\1{2,}/.test(tld)) return true;
  return false;
};

const validateForm = (payload) => {
  const nextErrors = {};
  const name = String(payload?.name || "").trim();
  const email = String(payload?.email || "").trim().toLowerCase();
  const phone = String(payload?.phone || "").trim();
  const password = String(payload?.password || "");

  if (!name) nextErrors.name = "Name is required.";
  else if (name.length < 2) nextErrors.name = "Name must be at least 2 characters.";
  else if (!NAME_REGEX.test(name)) nextErrors.name = "Name can contain only letters and spaces.";

  if (!email) nextErrors.email = "Email is required.";
  else if (!SUBADMIN_EMAIL_REGEX.test(email) || hasSuspiciousEmailTld(email)) nextErrors.email = "Enter a valid email address.";

  if (!phone) nextErrors.phone = "Phone is required.";
  else if (!INDIAN_MOBILE_REGEX.test(phone)) nextErrors.phone = "Enter a valid 10-digit Indian mobile number.";

  if (!password) nextErrors.password = "Password is required.";
  else if (password.length < 8) nextErrors.password = "Password must be at least 8 characters.";
  else if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^\w\s]/.test(password)) {
    nextErrors.password = "Use uppercase, lowercase, number, and special character.";
  }

  return nextErrors;
};

/**
 * Create a sub admin (employee): name, email, phone, password, and either a
 * role or the sidebar pages they may open. Used by Employees -> Add new; the
 * same POST /food/admin/sub-admins the list has always used.
 */
export default function SubAdminCreateForm({ onCreated }) {
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [pages, setPages] = useState(new Set());
  const [level, setLevel] = useState("full");
  const [roleId, setRoleId] = useState("");

  const handleCreate = async (e) => {
    e.preventDefault();
    const normalizedForm = {
      name: String(form.name || "").trim(),
      email: String(form.email || "").trim().toLowerCase(),
      phone: String(form.phone || "").trim(),
      password: String(form.password || ""),
    };
    const validationErrors = validateForm(normalizedForm);
    // A sub admin with no pages logs in to an empty panel.
    if (!roleId && !pages.size) validationErrors.pages = "Choose a role, or tick at least one page this sub admin can see.";
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    setSaving(true);
    try {
      const menuPaths = [...pages];
      await adminAPI.createSubAdmin(
        roleId
          ? { ...normalizedForm, roleId }
          : { ...normalizedForm, menuPaths, permissions: permissionsForPages(menuPaths, level) },
      );
      toast.success("Sub admin created");
      setRoleId("");
      setForm({ name: "", email: "", phone: "", password: "" });
      setPages(new Set());
      setLevel("full");
      setErrors({});
      onCreated?.();
    } catch {
      // The API client already shows the server's message.
    } finally {
      setSaving(false);
    }
  };

  const field = (key, props) => (
    <div>
      <input
        className={`border rounded-lg px-3 py-2 w-full ${errors[key] ? "border-red-400" : ""}`}
        value={form[key]}
        {...props}
      />
      {errors[key] ? <p className="mt-1 text-xs text-red-600">{errors[key]}</p> : null}
    </div>
  );
  const clear = (key) => errors[key] && setErrors((prev) => ({ ...prev, [key]: "" }));

  return (
    <form onSubmit={handleCreate} className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 md:grid-cols-2 gap-3">
      {field("name", {
        placeholder: "Name",
        onChange: (e) => {
          const cleaned = e.target.value.replace(/[^A-Za-z\s]/g, "").replace(/\s{2,}/g, " ");
          setForm((p) => ({ ...p, name: cleaned }));
          clear("name");
        },
      })}
      {field("email", {
        placeholder: "Email",
        onChange: (e) => {
          setForm((p) => ({ ...p, email: e.target.value }));
          clear("email");
        },
      })}
      {field("phone", {
        placeholder: "Phone",
        onChange: (e) => {
          const onlyDigits = e.target.value.replace(/\D/g, "").slice(0, 10);
          setForm((p) => ({ ...p, phone: onlyDigits }));
          clear("phone");
        },
      })}
      {field("password", {
        placeholder: "Password",
        type: "password",
        autoComplete: "new-password",
        onChange: (e) => {
          setForm((p) => ({ ...p, password: e.target.value }));
          clear("password");
        },
      })}
      <div className="md:col-span-2 border-t border-slate-200 pt-4 space-y-4">
        <RoleSelect value={roleId} onChange={setRoleId} />
        {!roleId && (
          <SidebarAccessPicker
            selected={pages}
            onChange={(next) => {
              setPages(next);
              clear("pages");
            }}
            level={level}
            onLevelChange={setLevel}
          />
        )}
        {errors.pages ? <p className="mt-2 text-xs text-red-600">{errors.pages}</p> : null}
      </div>
      <div className="md:col-span-2">
        <button disabled={saving} className="inline-flex items-center gap-2 px-4 py-2 bg-black text-white rounded-lg disabled:opacity-60">
          <Plus className="w-4 h-4" /> Create Sub Admin
        </button>
      </div>
    </form>
  );
}
