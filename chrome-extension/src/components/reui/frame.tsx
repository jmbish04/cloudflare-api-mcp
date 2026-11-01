import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const frameVariants = cva(
  "relative flex flex-col rounded-xl border border-border/70 bg-card/60 backdrop-blur-xs overflow-hidden",
  {
    variants: {
      variant: {
        default: "border-border/70 bg-card/60",
        inverse: "border-border bg-background",
        ghost: "border-transparent bg-transparent",
      },
      spacing: {
        default: "p-4 gap-3",
        sm: "p-3 gap-2.5",
        xs: "p-2 gap-2",
        dense: "p-0 gap-0",
      },
    },
    defaultVariants: {
      variant: "default",
      spacing: "default",
    },
  }
);

export interface FrameProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof frameVariants> {}

function Frame({ className, variant, spacing, ...props }: FrameProps) {
  return (
    <div
      className={cn(frameVariants({ variant, spacing, className }))}
      data-slot="frame"
      {...props}
    />
  );
}

function FramePanel({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative rounded-lg border border-border/60 bg-muted/30 p-3.5 shadow-xs",
        className
      )}
      data-slot="frame-panel"
      {...props}
    />
  );
}

function FrameHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <header
      className={cn("flex flex-col gap-1 pb-1", className)}
      data-slot="frame-header"
      {...props}
    />
  );
}

function FrameTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-xs font-semibold text-foreground tracking-tight flex items-center gap-1.5", className)}
      data-slot="frame-title"
      {...props}
    />
  );
}

function FrameDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("text-[11px] text-muted-foreground leading-relaxed", className)}
      data-slot="frame-description"
      {...props}
    />
  );
}

function FrameFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <footer
      className={cn("flex items-center justify-between pt-2 border-t border-border/40 text-xs text-muted-foreground", className)}
      data-slot="frame-footer"
      {...props}
    />
  );
}

export {
  Frame,
  FramePanel,
  FrameHeader,
  FrameTitle,
  FrameDescription,
  FrameFooter,
  frameVariants,
};
