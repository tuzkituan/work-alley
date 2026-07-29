import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",

        // --- design 1a variants ---------------------------------------------
        // The design's focus/hover ring is --adaptive-300, not --ring (brand
        // orange), so these override new-york's ring treatment. Stock variants
        // above are left untouched.
        waOutline:
          "border border-adaptive-200 bg-background text-adaptive-800 hover:border-adaptive-950 hover:shadow-focus-ring focus-visible:border-adaptive-950 focus-visible:ring-0 focus-visible:shadow-focus-ring",
        waPrimary:
          "border border-primary-600 bg-primary-600 text-white hover:bg-primary-500 hover:border-adaptive-950 hover:shadow-focus-ring focus-visible:ring-0 focus-visible:shadow-focus-ring",
        waDanger:
          "border border-error-500 bg-transparent text-error-500 hover:shadow-focus-ring focus-visible:ring-0 focus-visible:shadow-focus-ring",
        waGhost:
          "bg-transparent text-adaptive-800 hover:bg-adaptive-200 focus-visible:ring-0 focus-visible:shadow-focus-ring",
        waDashed:
          "border border-dashed border-adaptive-300 bg-transparent text-adaptive-600 font-mono hover:border-solid hover:border-adaptive-950 hover:text-adaptive-900 focus-visible:ring-0 focus-visible:shadow-focus-ring",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",

        // --- design 1a sizes ------------------------------------------------
        wa: "h-[30px] gap-1.5 rounded-md px-2.5 text-xs font-semibold",
        waSm: "h-[28px] gap-1.5 rounded-md px-2.5 text-xs font-semibold",
        waXs: "h-6 gap-1 rounded-[5px] px-2 text-[11px] font-semibold",
        waChip: "h-[26px] gap-1 rounded-[5px] px-[9px] text-[11px] font-normal",
        waIcon: "size-[26px] rounded-[5px] text-xs",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
