import type { ReactNode } from 'react';
import { cn } from '@projexlight/design-system';
import { MarketingHeader } from './MarketingHeader';
import { MarketingFooter } from './MarketingFooter';

/**
 * Shared chrome for the public auth/marketing-flow pages (/login, /signup,
 * /register): marketing header + gradient band + a centered white card +
 * footer. `wide` widens the card for success/confirmation panels.
 */
export function AuthShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <MarketingHeader />
      <section className="bg-gradient-to-b from-background to-muted px-8 py-14">
        <div className={cn('mx-auto rounded-xl border bg-card px-9 py-8 shadow-sm', className)}>
          {children}
        </div>
      </section>
      <MarketingFooter />
    </div>
  );
}
