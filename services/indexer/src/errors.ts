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
export class MissingBlockTime extends IndexerError {
  override readonly name = "MissingBlockTime";
}
