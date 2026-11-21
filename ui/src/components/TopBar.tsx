// The bar at the top of the main panel: a sidebar toggle, the page title,
// the page's own controls (the bucket tabs), and the theme choice.

import type { ReactNode } from "react"
import { Button } from "@ui-sdk/react/button"
import { usePreference } from "@ui-sdk/react/preferences"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select"
import { colorScheme } from "../theme"
import { SidebarIcon } from "./Icons"

const SCHEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const

function ThemeSelect() {
  const { value } = usePreference(colorScheme)
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next) colorScheme.set(next as (typeof SCHEMES)[number]["value"])
      }}
    >
      <SelectLabel className="sr-only">Theme</SelectLabel>
      <SelectTrigger className="theme-trigger">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SCHEMES.map((s) => (
          <SelectItem key={s.value} value={s.value}>
            {s.label}
            <SelectItemIndicator />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function TopBar({
  title,
  sidebarOpen,
  onToggleSidebar,
  children,
}: {
  title: ReactNode
  sidebarOpen: boolean
  onToggleSidebar: () => void
  children?: ReactNode
}) {
  return (
    <header className="topbar">
      <div className="topbar-row">
        <Button
          className="icon-button"
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-expanded={sidebarOpen}
          aria-controls="sidebar"
          onClick={onToggleSidebar}
        >
          <SidebarIcon />
        </Button>
        <h1 className="topbar-title">{title}</h1>
        <div className="spacer" />
        <ThemeSelect />
      </div>
      {children}
    </header>
  )
}
