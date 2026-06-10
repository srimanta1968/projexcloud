import * as React from 'react';
import { cn } from '../lib/cn';

/** Centered page container with a sane max width and horizontal padding. */
export function Container({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('mx-auto w-full max-w-5xl px-6', className)} {...props} />;
}

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned actions (buttons, links). */
  actions?: React.ReactNode;
}

/** Standard page title block: heading + optional description + right-aligned actions. */
export function PageHeader({
  title,
  description,
  actions,
  className,
  ...props
}: PageHeaderProps): React.JSX.Element {
  return (
    <div
      className={cn('mb-6 flex flex-wrap items-start justify-between gap-4', className)}
      {...props}
    >
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
