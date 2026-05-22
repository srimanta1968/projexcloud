// Known-bad: instantiates raw pg.Client outside @projexlight/db-runtime.
// OC-3 should flag this as an error.
import { Client } from 'pg';

export const c = new Client();
