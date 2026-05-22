import * as React from 'react';
import { cn } from '../lib/cn';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  errorText?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, errorText, id, className, ...rest },
  ref,
) {
  const inputId = id ?? React.useId();
  return (
    <div className="pl-field">
      {label && <label htmlFor={inputId}>{label}</label>}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={errorText ? true : undefined}
        className={cn('pl-input', errorText && 'pl-input--error', className)}
        {...rest}
      />
      {errorText && <p role="alert" className="pl-field__error">{errorText}</p>}
    </div>
  );
});
