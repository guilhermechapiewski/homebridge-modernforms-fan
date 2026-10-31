/**
 * Name users reference in the Homebridge config.json `platform` field.
 * Must match `pluginAlias` in config.schema.json.
 */
export const PLATFORM_NAME = 'ModernFormsFan';

/** Must match the `name` in package.json. */
export const PLUGIN_NAME = 'homebridge-modernforms-fan';

/** Background status check per fan. 0 turns it off. */
export const DEFAULT_POLLING_INTERVAL_SECONDS = 60;
export const MIN_POLLING_INTERVAL_SECONDS = 10;

/** Status refreshes triggered by Home reading an accessory are at most this frequent. */
export const ON_DEMAND_REFRESH_MIN_INTERVAL_MS = 5_000;

/** How often to look for new fans and changed IP addresses. */
export const DISCOVERY_INTERVAL_MS = 5 * 60_000;

/** How long to collect mDNS answers after each discovery query. */
export const DISCOVERY_LISTEN_MS = 3_000;

/** An unreachable fan triggers an extra discovery at most this often (its IP may have changed). */
export const REDISCOVERY_MIN_INTERVAL_MS = 60_000;

/**
 * HomeKit sends related changes (e.g. On + Brightness when dragging a slider)
 * as separate writes a few ms apart; they are merged into one request.
 */
export const COMMAND_COALESCE_MS = 50;

/** Consecutive failed requests before a fan shows "No Response". */
export const OFFLINE_AFTER_FAILURES = 2;
