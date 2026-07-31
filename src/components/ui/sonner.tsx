import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

import { useUiStore } from "@/stores/ui-store"

const Toaster = ({ ...props }: ToasterProps) => {
  // The app's own theme, not next-themes'.
  //
  // No ThemeProvider is mounted, so `useTheme()` resolved to "system" every time
  // and the toast followed the *OS* preference — while the rest of the app follows
  // an explicit light/dark choice that deliberately does not (see use-theme.ts). On
  // any machine whose OS and app themes differ, that put a dark toast over a light
  // app. Reading the store is also what makes the toast flip the instant the
  // in-app toggle does.
  const theme = useUiStore((s) => s.theme)

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          // `rounded-md`, which is what every menu and popover uses — not
          // `--radius` itself, which is the container radius.
          "--border-radius": "var(--radius-md)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
