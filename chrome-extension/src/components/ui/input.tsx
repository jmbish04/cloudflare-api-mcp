import * as React from "react";
import { cn } from "../../lib/utils";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  description?: string;
  error?: string;
  leftIcon?: React.ReactNode;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", label, description, error, leftIcon, id, ...props }, ref) => {
    return (
      <div className="space-y-1.5 w-full">
        {label && (
          <label
            htmlFor={id}
            className="text-xs font-medium text-foreground select-none block"
          >
            {label}
          </label>
        )}
        <div className="relative flex items-center">
          {leftIcon && (
            <div className="absolute left-2.5 pointer-events-none text-muted-foreground">
              {leftIcon}
            </div>
          )}
          <input
            type={type}
            id={id}
            className={cn(
              "flex h-8 w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              leftIcon && "pl-8",
              error && "border-destructive focus:border-destructive focus:ring-destructive",
              className
            )}
            ref={ref}
            {...props}
          />
        </div>
        {description && (
          <p className="text-[11px] text-muted-foreground select-none leading-relaxed">{description}</p>
        )}
        {error && (
          <p className="text-[10px] text-destructive font-medium select-none">{error}</p>
        )}
      </div>
    );
  }
);
Input.displayName = "Input";

export { Input };
