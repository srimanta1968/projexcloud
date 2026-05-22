import * as React from 'react';
import { cn } from '../lib/cn';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Card({ className, ...rest }: CardProps): React.JSX.Element {
  return <div className={cn('pl-card', className)} {...rest} />;
}

export function CardHeader({ className, ...rest }: CardProps): React.JSX.Element {
  return <div className={cn('pl-card__header', className)} {...rest} />;
}

export function CardBody({ className, ...rest }: CardProps): React.JSX.Element {
  return <div className={cn('pl-card__body', className)} {...rest} />;
}
