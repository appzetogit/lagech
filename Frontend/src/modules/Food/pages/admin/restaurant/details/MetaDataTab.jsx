import { Link } from "react-router-dom"
import { Panel, EmptyState } from "./shared"

/**
 * The old panel's per-store SEO meta title, description and image. Restaurants
 * here have no such fields -- the customer site's meta tags are set once for
 * the whole site -- so this tab says so rather than offering a form that
 * would save nowhere.
 */
export default function MetaDataTab() {
  return (
    <Panel title="Meta data" bodyClassName="">
      <EmptyState title="No per-store meta data">
        Restaurants in this system do not carry their own SEO meta title, description or image. The site-wide meta tags
        are set under{" "}
        <Link to="/admin/food/page-meta-data" className="text-teal-700 hover:underline">
          Page meta data
        </Link>
        .
      </EmptyState>
    </Panel>
  )
}
