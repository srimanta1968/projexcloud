import * as React from 'react';
import { cn } from '../lib/cn';
import { Label } from './Label';

export interface FieldProps {
  label?: React.ReactNode;
  /** Helper text shown below the control. */
  hint?: React.ReactNode;
  /** Error message; when set, replaces the hint and is announced to AT. */
  error?: React.ReactNode;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}

/** Vertical form-field layout: label, control, and hint/error text. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: FieldProps): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && <Label htmlFor={htmlFor}>{label}</Label>}
      {children}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
