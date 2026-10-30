// HubClient's capped backoff and its maximum positive jitter.
export const MAX_RECONNECT_DELAY_MS = 5000;
export const RECONNECT_JITTER = 0.25;
export const MAX_RECONNECT_PAUSE_MS = MAX_RECONNECT_DELAY_MS * (1 + RECONNECT_JITTER);
