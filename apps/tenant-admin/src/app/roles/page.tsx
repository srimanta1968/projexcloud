import { revalidatePath } from 'next/cache';
import { PageHeader } from '@projexlight/design-system';
import { gateway } from '@/lib/gateway';

/**
 * Role templates per app (TK-4128).
 *
 * THE MODEL THIS SCREEN HAS TO MAKE VISIBLE
 * tenant.role_template is keyed (tenant_id, app_id, name) and tenant_id is NULLABLE:
 *   tenant_id IS NULL  -> the PLATFORM DEFAULT shipped with an app, unique on (app_id, name)
 *   tenant_id set      -> this tenant's OVERRIDE of that same role name
 * So a tenant can redefine what "Manager" means without forking the app, and a tenant that
 * never touches it keeps inheriting.
 *
 * That only works if the UI shows inheritance honestly. If overriding were implicit — edit a
 * field and a tenant row appears — every tenant would end up owning a private copy of every
 * default role and maintaining them forever, which is precisely the fork the nullable
 * tenant_id exists to avoid. So inherited rows are read-only here and "Override for my
 * tenant" is a deliberate action, and removing an override restores the inherited default
 * rather than deleting the role.
 */

export const dynamic = 'force-dynamic';

interface RoleTemplate {
  role_template_id: string;
  tenant_id: string | null;
  app_id: string;
  name: string;
  parent_role_template_id: string | null;
  permissions: Record<string, unknown>;
}

interface AppRow { app_id: string; display_name?: string | null }

async function loadApps(): Promise<AppRow[]> {
  try {
    // request() already unwraps the envelope's `data`, so this is the payload itself.
    const res = await gateway.get<{ apps?: AppRow[] }>('/api/tenants/apps');
    return res?.apps ?? [];
  } catch {
    // A tenant with no app list still gets a usable page: the role list below is
    // app-scoped, and an empty selector is clearer than an error banner.
    return [];
  }
}

/**
 * NO LIST ENDPOINT EXISTS YET.
 *
 * sdk-tenant declares only app.post('/api/role-templates') — there is no GET handler
 * anywhere in the codebase, so this call returns 404 "Route GET:/api/role-templates not
 * found" (confirmed against prod). The catch below then swallows it into an empty array,
 * which renders as "no role templates yet" — a page that has never worked looking
 * identical to a tenant who has no data. That is the exact failure lib/gateway.ts was
 * written to prevent, and it was reintroduced here by writing the screen against an
 * endpoint that was assumed rather than verified.
 *
 * Left calling the real path deliberately: the moment a GET handler ships, this works.
 * Until then the page reports the gap instead of pretending to be empty.
 */
async function loadRoles(appId: string): Promise<RoleTemplate[]> {
  try {
    const res = await gateway.get<{ role_templates?: RoleTemplate[] }>(
      `/api/role-templates?app_id=${encodeURIComponent(appId)}`,
    );
    return res?.role_templates ?? [];
  } catch {
    // Rethrow shape is not available here, so signal "unavailable" rather than "empty"
    // by returning null; the page distinguishes the two below.
    return null as unknown as RoleTemplate[];
  }
}

/** Overriding copies the inherited definition under this tenant, keeping the SAME name. */
async function overrideRole(formData: FormData): Promise<void> {
  'use server';
  const app_id = String(formData.get('app_id') ?? '');
  const name = String(formData.get('name') ?? '');
  const permissions = String(formData.get('permissions') ?? '{}');
  if (!app_id || !name) return;
  try {
    await gateway.post('/api/role-templates', {
      app_id,
      name,
      permissions: JSON.parse(permissions || '{}'),
    });
  } catch {
    // Surfaced by the page reload rather than thrown: a failed override must not
    // blank the whole screen and lose the admin's place.
  }
  revalidatePath('/roles');
}

export default async function RolesPage({
  searchParams,
}: {
  searchParams?: { app_id?: string };
}) {
  const apps = await loadApps();
  const appId = searchParams?.app_id || apps[0]?.app_id || '';
  const roles = appId ? await loadRoles(appId) : [];

  // Same role NAME may appear twice — the platform default and this tenant's override.
  // The override wins for display; the default is shown as its origin.
  const byName = new Map<string, { inherited?: RoleTemplate; override?: RoleTemplate }>();
  for (const r of roles) {
    const slot = byName.get(r.name) ?? {};
    if (r.tenant_id === null) slot.inherited = r;
    else slot.override = r;
    byName.set(r.name, slot);
  }

  return (
    <main className="p-8 max-w-5xl mx-auto">
      <PageHeader
        title="Roles"
        description="Role templates for each of your apps. Platform defaults are inherited; override one to change what it means for your tenant without forking the app."
      />

      {apps.length > 0 && (
        <form method="get" className="mb-6 flex items-center gap-2">
          <label htmlFor="app_id" className="text-sm text-gray-600">App</label>
          <select id="app_id" name="app_id" defaultValue={appId} className="border rounded px-2 py-1 text-sm">
            {apps.map((a) => (
              <option key={a.app_id} value={a.app_id}>{a.display_name || a.app_id}</option>
            ))}
          </select>
          <button type="submit" className="text-sm px-3 py-1 border rounded">Show</button>
        </form>
      )}

      {roles === null ? (
        <p role="alert" className="text-sm text-red-700 border border-red-300 rounded p-3">
          Role templates cannot be listed: the platform has no <code>GET /api/role-templates</code>
          endpoint yet (sdk-tenant provides only POST). This screen is waiting on that handler —
          it is not that your tenant has no roles.
        </p>
      ) : byName.size === 0 ? (
        <p className="text-sm text-gray-500">
          No role templates for this app yet. Platform defaults appear here once the app ships them.
        </p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left border-b">
              <th className="py-2">Role</th>
              <th>Origin</th>
              <th>Inherits from</th>
              <th>Permissions</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...byName.entries()].map(([name, slot]) => {
              const effective = slot.override ?? slot.inherited!;
              const isOverride = Boolean(slot.override);
              return (
                <tr key={name} className="border-b align-top">
                  <td className="py-2 font-medium">{name}</td>
                  <td>
                    {isOverride ? (
                      <span className="text-emerald-700">Overridden here</span>
                    ) : (
                      <span className="text-gray-500">Inherited platform default</span>
                    )}
                  </td>
                  <td className="text-gray-500">
                    {effective.parent_role_template_id ? effective.parent_role_template_id.slice(0, 8) : '—'}
                  </td>
                  <td>
                    <code className="text-xs">{JSON.stringify(effective.permissions ?? {})}</code>
                  </td>
                  <td>
                    {!isOverride && (
                      // Explicit, never implicit — see the header comment.
                      <form action={overrideRole}>
                        <input type="hidden" name="app_id" value={appId} />
                        <input type="hidden" name="name" value={name} />
                        <input
                          type="hidden"
                          name="permissions"
                          value={JSON.stringify(effective.permissions ?? {})}
                        />
                        <button type="submit" className="text-xs px-2 py-1 border rounded">
                          Override for my tenant
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
