// Known-bad: imports the AWS KMS SDK directly from outside sdk-secrets.
// OC-9 should flag this as an error.
import * as kms from '@aws-sdk/client-kms';
export const x = kms;
