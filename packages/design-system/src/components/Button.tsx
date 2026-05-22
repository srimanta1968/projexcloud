import * as React from 'react';
import { cn } from '../lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'pl-btn pl-btn--primary',
  secondary: 'pl-btn pl-btn--secondary',
  ghost: 'pl-btn pl-btn--ghost',
  danger: 'pl-btn pl-btn--danger',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'pl-btn--sm',
  md: 'pl-btn--md',
  lg: 'pl-btn--lg',
};

/** Minimal Button primitive. Full shadcn/ui set lands incrementally. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(VARIANT_CLASS[variant], SIZE_CLASS[size], className)}
      {...rest}
    />
  );
});
