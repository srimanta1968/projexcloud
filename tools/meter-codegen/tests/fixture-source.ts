// Fixture used by AC-12 test. Has two @meter-decorated methods.
declare const meter: (sku: string, unit: string, tier: string) => MethodDecorator;

export class VaultRoutes {
  @meter('vault.encrypt', 'call', 'core')
  encrypt(): void { /* noop */ }

  @meter('vault.decrypt', 'call', 'core')
  decrypt(): void { /* noop */ }
}
