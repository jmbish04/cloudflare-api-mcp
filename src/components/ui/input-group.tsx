import * as React from 'react'
import { cn } from '@/lib/utils'

export function InputGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('relative flex items-center w-full', className)} {...props} />
}

export function InputGroupInput({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'flex h-10 w-full rounded-lg border border-input bg-input px-3.5 pr-10 py-2 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono',
        className
      )}
      {...props}
    />
  )
}

export function InputGroupAddon({
  align = 'inline-end',
  className,
  ...props
}: React.ComponentProps<'div'> & { align?: 'inline-start' | 'inline-end' }) {
  return (
    <div
      className={cn(
        'absolute top-0 bottom-0 flex items-center justify-center',
        align === 'inline-end' ? 'right-0' : 'left-0',
        className
      )}
      {...props}
    />
  )
}

export function InputGroupButton({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'h-full px-3 text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center cursor-pointer',
        className
      )}
      {...props}
    />
  )
}
