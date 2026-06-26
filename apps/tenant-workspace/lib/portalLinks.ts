/**
 * Cross-portal link targets.
 *
 * In production all three portals are served same-origin behind nginx under
 * path prefixes (/workspace, /tenant, /console), so the correct links are
 * root-relative (e.g. "/tenant"). In local dev each portal runs on its own
 * port (workspace 3300, tenant 3200, console 3100), so the links are absolute
 * localhost URLs.
 *
 * Values are baked at build time via NEXT_PUBLIC_* (see deploy/portals/Dockerfile
 * and scripts/setup/docker-compose.portals.yml). Defaults target local dev.
 */
export const TENANT_URL = process.env.NEXT_PUBLIC_TENANT_URL || 'http://localhost:3200';
export const CONSOLE_URL = process.env.NEXT_PUBLIC_CONSOLE_URL || 'http://localhost:3100';
export const TENANT_BILLING_URL = `${TENANT_URL}/billing`;
