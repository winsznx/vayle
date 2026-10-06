// Every way a watcher run can fail has its own name.

export class WatcherError extends Error {}

export class MissingSetting extends WatcherError {
  override readonly name = "MissingSetting";
}
export class MarketConfigIncomplete extends WatcherError {
  override readonly name = "MarketConfigIncomplete";
}
export class StoreRequestFailed extends WatcherError {
  override readonly name = "StoreRequestFailed";
}
export class StoreRowMalformed extends WatcherError {
  override readonly name = "StoreRowMalformed";
}
export class WebhookFailed extends WatcherError {
  override readonly name = "WebhookFailed";
}
