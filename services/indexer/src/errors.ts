// Every way an indexer run or API call can fail has its own name.

export class IndexerError extends Error {}

export class MissingSetting extends IndexerError {
  override readonly name = "MissingSetting";
}
export class StoreRequestFailed extends IndexerError {
  override readonly name = "StoreRequestFailed";
}
export class StoreRowMalformed extends IndexerError {
  override readonly name = "StoreRowMalformed";
}
// The RPC won't serve a log range this wide. The same request gets the same answer, so retrying
// can't help.
export class LogRangeRefused extends IndexerError {
  override readonly name = "LogRangeRefused";
}
