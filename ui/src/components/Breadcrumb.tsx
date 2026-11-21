// The breadcrumb for a prefix in a bucket. The SDK has none, so this
// follows the WAI-ARIA breadcrumb pattern: a labelled nav with an ordered
// list of links, the current place marked with aria-current="page".

import { crumbs } from "../route"
import { bucketRoute, routeHash } from "../route"
import { ChevronRightIcon } from "./Icons"

export function Breadcrumb({ bucket, prefix }: { bucket: string; prefix: string }) {
  const items = crumbs(bucket, prefix)
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <ol>
        {items.map((crumb, index) => {
          const current = index === items.length - 1
          return (
            <li key={crumb.prefix}>
              {index > 0 && <ChevronRightIcon />}
              {current ? (
                <span aria-current="page">{crumb.label}</span>
              ) : (
                <a href={routeHash(bucketRoute(bucket, "objects", crumb.prefix))}>{crumb.label}</a>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
