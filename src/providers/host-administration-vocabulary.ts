/** The one home for this vocabulary: the owner that raises a code and the transport that renders it both read
 *  it from here, so neither can name a code the other does not know. */
export const PROVIDER_HOST_ADMINISTRATION_ERROR_CODES = [
  'provider_host_inventory_unavailable',
  'provider_host_owner_torn_down',
  'provider_host_not_found',
  'provider_host_ambiguous',
  'provider_host_eviction_requires_exact_ref',
  'provider_host_identity_integrity',
  'provider_host_operator_abandoned',
  'provider_host_shutdown_held',
  'provider_host_stale',
] as const;

export type ProviderHostAdministrationErrorCode = (typeof PROVIDER_HOST_ADMINISTRATION_ERROR_CODES)[number];
