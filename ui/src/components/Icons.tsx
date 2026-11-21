// Inline SVG icons (docs/UI.md: no external resources). Each is decorative;
// the control that holds it carries the accessible name.

import type { ReactNode, SVGProps } from "react"

function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  )
}

export const BucketIcon = () => (
  <Icon>
    <path d="M4 7h16l-1.5 12.5a1 1 0 0 1-1 .5h-11a1 1 0 0 1-1-.5Z" />
    <path d="M3 7a9 3 0 0 0 18 0" />
  </Icon>
)

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

export const TrashIcon = () => (
  <Icon>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Icon>
)

export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
)

export const SidebarIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Icon>
)

export const FolderIcon = () => (
  <Icon>
    <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
  </Icon>
)

export const FileIcon = () => (
  <Icon>
    <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7Z" />
    <path d="M14 3v4h4" />
  </Icon>
)

export const ChevronRightIcon = () => (
  <Icon>
    <path d="m9 6 6 6-6 6" />
  </Icon>
)

export const RefreshIcon = () => (
  <Icon>
    <path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.6M20 4v4.6h-4.6" />
  </Icon>
)

export const CheckIcon = () => (
  <Icon>
    <path d="m5 12 5 5 9-10" />
  </Icon>
)

export const XIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
)

export const UploadIcon = () => (
  <Icon>
    <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </Icon>
)

export const DownloadIcon = () => (
  <Icon>
    <path d="M12 4v12M7 11l5 5 5-5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </Icon>
)

export const FolderPlusIcon = () => (
  <Icon>
    <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
    <path d="M12 10v6M9 13h6" />
  </Icon>
)

export const CopyIcon = () => (
  <Icon>
    <rect x="8" y="8" width="12" height="12" rx="1" />
    <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
  </Icon>
)

export const MoreIcon = () => (
  <Icon>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </Icon>
)
