import type { ReactNode } from "react";
import { Badge } from "./reui/badge";
import { IconTile } from "./reui/icon-tile";
import { ThemeToggle } from "./theme-toggle";

export interface AppHeaderProps {
  icon: ReactNode;
  title: string;
  subtitle: string;
  /** Short label for the badge beside the title. Omit for no badge. */
  tag?: string;
  /** Status or actions, rendered before the theme toggle. */
  actions?: ReactNode;
}

/**
 * The popup header.
 *
 * A popup is 380px, so this is the narrow app-shell topology: one brand block, one
 * action cluster, nothing else. The workspace selector and avatar menu the wider ReUI
 * shells carry are stripped — this extension has neither workspaces nor users.
 */
export function AppHeader({ icon, title, subtitle, tag, actions }: AppHeaderProps) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card/60 px-3 py-2.5 backdrop-blur-xs">
      <div className="flex min-w-0 items-center gap-2.5">
        <IconTile variant="frame" size="sm" className="text-warning" aria-hidden="true">
          {icon}
        </IconTile>
        <div className="min-w-0">
          <h1 className="flex items-center gap-1.5 text-xs leading-tight font-semibold tracking-tight text-foreground">
            <span className="truncate">{title}</span>
            {tag && (
              <Badge variant="primary-light" size="xs" radius="full">
                {tag}
              </Badge>
            )}
          </h1>
          <p className="truncate text-[10px] text-muted-foreground">{subtitle}</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {actions}
        <ThemeToggle />
      </div>
    </header>
  );
}
