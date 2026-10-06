/**
 * Admin icons in the previous panel's TIO icon font.
 *
 * Exports the same names as lucide-react, so an admin page switches over by
 * changing only its import. Icons listed below render the TIO glyph the old
 * panel used for the same action; anything else falls through to lucide via
 * the `export *` at the bottom (named exports here take precedence).
 *
 * Sizing follows the lucide habits in our pages: `w-4 h-4` classes or a
 * `size` prop become the glyph's font size; colour comes from `text-*`.
 */
import { forwardRef } from "react"

const PX_BY_TW = { 3: 12, 3.5: 14, 4: 16, 5: 20, 6: 24, 7: 28, 8: 32, 10: 40, 12: 48 }

function sizeFrom(className = "", size) {
  if (size) return Number(size) || 16
  const match = String(className).match(/(?:^|\s)(?:w|h|size)-(\d+(?:\.5)?)(?=\s|$)/)
  return match ? PX_BY_TW[match[1]] || Number(match[1]) * 4 : 16
}

function tio(glyph, displayName) {
  const Icon = forwardRef(function TioIcon({ className = "", size, style, ...rest }, ref) {
    // lucide-only props have no meaning for a font glyph
    delete rest.strokeWidth
    delete rest.absoluteStrokeWidth
    delete rest.color
    const px = sizeFrom(className, size)
    return (
      <i
        ref={ref}
        aria-hidden="true"
        className={`tio-${glyph} inline-flex shrink-0 items-center justify-center leading-none ${className}`}
        style={{ fontSize: px, width: px, height: px, ...style }}
        {...rest}
      />
    )
  })
  Icon.displayName = displayName
  return Icon
}

// Actions, as the old panel shows them.
export const Search = tio("search", "Search")
export const Settings = tio("settings", "Settings")
export const ChevronDown = tio("chevron-down", "ChevronDown")
export const ChevronUp = tio("chevron-up", "ChevronUp")
export const ChevronLeft = tio("chevron-left", "ChevronLeft")
export const ChevronRight = tio("chevron-right", "ChevronRight")
export const Download = tio("download-to", "Download")
export const FileDown = tio("download-to", "FileDown")
export const Upload = tio("upload-on-cloud", "Upload")
export const FileText = tio("file-text-outlined", "FileText")
export const FileSpreadsheet = tio("file-text-outlined", "FileSpreadsheet")
export const Eye = tio("visible-outlined", "Eye")
export const EyeOff = tio("hidden-outlined", "EyeOff")
export const ArrowUpDown = tio("sort", "ArrowUpDown")
export const Plus = tio("add", "Plus")
export const PlusCircle = tio("add-circle-outlined", "PlusCircle")
export const Code = tio("code", "Code")
export const Trash2 = tio("delete-outlined", "Trash2")
export const Trash = tio("delete-outlined", "Trash")
export const Check = tio("done", "Check")
export const CheckCircle = tio("checkmark-circle-outlined", "CheckCircle")
export const CheckCircle2 = tio("checkmark-circle-outlined", "CheckCircle2")
export const Calendar = tio("calendar-month", "Calendar")
export const X = tio("clear", "X")
export const XCircle = tio("clear-circle-outlined", "XCircle")
export const Info = tio("info-outined", "Info")
export const Filter = tio("filter-list", "Filter")
export const MapPin = tio("poi-outlined", "MapPin")
export const Edit = tio("edit", "Edit")
export const Pencil = tio("edit", "Pencil")
export const Columns = tio("column-view-outlined", "Columns")
export const Clock = tio("time", "Clock")
export const User = tio("user-outlined", "User")
export const Users = tio("poi-user", "Users")
export const Star = tio("star", "Star")
export const Save = tio("save", "Save")
export const Mail = tio("email-outlined", "Mail")
export const Phone = tio("call-talking", "Phone")
export const Package = tio("archive", "Package")
export const ArrowLeft = tio("arrow-backward", "ArrowLeft")
export const ArrowRight = tio("arrow-forward", "ArrowRight")
export const Wallet = tio("wallet", "Wallet")
export const Image = tio("image", "Image")
export const Shield = tio("security-on-outlined", "Shield")
export const RefreshCw = tio("refresh", "RefreshCw")
export const IndianRupee = tio("money", "IndianRupee")
export const DollarSign = tio("money", "DollarSign")
export const Bike = tio("bike", "Bike")
export const Truck = tio("truck", "Truck")
export const UtensilsCrossed = tio("restaurant", "UtensilsCrossed")
export const Utensils = tio("meal-outlined", "Utensils")
export const Heart = tio("heart-outlined", "Heart")
export const Folder = tio("folder-opened", "Folder")
export const ExternalLink = tio("open-in-new", "ExternalLink")
export const CreditCard = tio("credit-card", "CreditCard")
export const Printer = tio("print", "Printer")
export const Copy = tio("copy", "Copy")
export const Bell = tio("notifications", "Bell")
export const Lock = tio("lock-outlined", "Lock")
export const MoreVertical = tio("more-vertical", "MoreVertical")
export const MoreHorizontal = tio("more-horizontal", "MoreHorizontal")
export const Link = tio("link", "Link")
export const Share2 = tio("share", "Share2")
export const Home = tio("home-outlined", "Home")
export const LogOut = tio("sign-out", "LogOut")
export const Gift = tio("gift", "Gift")
export const Megaphone = tio("tv-old", "Megaphone")

// Spinners and anything without a TIO equivalent stay lucide.
export * from "lucide-react"
