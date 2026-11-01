import * as React from "react";
import { cn } from "../../lib/utils";
import { Frame, FramePanel } from "./frame";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  badge?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  badge,
  className,
}: EmptyStateProps) {
  return (
    <Frame className={cn("text-center", className)} variant="default">
      <FramePanel className="flex flex-col items-center justify-center py-8 px-6 space-y-3 bg-card/60">
        {icon && (
          <div className="w-12 h-12 rounded-2xl bg-muted border border-border flex items-center justify-center text-foreground shadow-xs">
            {icon}
          </div>
        )}

        {badge && <div>{badge}</div>}

        <div className="space-y-1 max-w-sm">
          <h3 className="text-sm font-semibold text-foreground tracking-tight">{title}</h3>
          {description && (
            <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
          )}
        </div>

        {(action || secondaryAction) && (
          <div className="flex items-center gap-2 pt-2">
            {secondaryAction}
            {action}
          </div>
        )}
      </FramePanel>
    </Frame>
  );
}
