// Known-bad: references the literal '.env' in source.
// OC-6 should flag this as an error.
import fs from 'fs';
export const path = '.env';
const _ = fs;
