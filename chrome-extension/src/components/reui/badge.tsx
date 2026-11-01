import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";
import { X } from "lucide-react";

const badgeVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center w-fit border border-transparent font-medium whitespace-nowrap outline-none transition-shadow",
    "focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        outline: "border-border bg-transparent text-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        info: "bg-info text-white",
        success: "bg-success text-white",
        warning: "bg-warning text-white",
        destructive: "bg-destructive text-destructive-foreground",
        "primary-light":
          "border-primary/20 bg-primary/10 text-primary",
        "warning-light":
          "border-warning/30 bg-warning/10 text-warning",
        "success-light":
          "border-success/30 bg-success/10 text-success",
        "info-light":
          "border-info/30 bg-info/10 text-info",
        "destructive-light":
          "border-destructive/20 bg-destructive/10 text-destructive",
      },
      size: {
        xs: "px-1.5 py-0.25 text-[10px] leading-none h-4 min-w-4 gap-1",
        sm: "px-2 py-0.5 text-[11px] leading-tight h-5 min-w-5 gap-1",
        default: "px-2.5 py-0.5 text-xs h-5.5 min-w-5.5 gap-1.5",
        lg: "px-3 py-1 text-sm h-6 min-w-6 gap-2",
      },
      radius: {
        default: "rounded-md",
        full: "rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      radius: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  onDismiss?: () => void;
  dismissible?: boolean;
}

function Badge({
  className,
  variant,
  size,
  radius,
  children,
  onDismiss,
  dismissible,
  ...props
}: BadgeProps) {
  return (
    <div
      className={cn(badgeVariants({ variant, size, radius }), className)}
      data-slot="badge"
      {...props}
    >
      <span>{children}</span>
      {(dismissible || onDismiss) && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss?.();
          }}
          className="ml-0.5 inline-flex h-3 w-3 items-center justify-center rounded-full hover:bg-foreground/20 hover:text-foreground text-foreground/70 transition-colors pointer-events-auto cursor-pointer"
          aria-label="Remove badge"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}

export { Badge, badgeVariants };
