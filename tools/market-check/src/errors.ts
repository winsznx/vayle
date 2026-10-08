// Each way the run itself can't go on has a name. A check that can't run for one token is
// recorded in the output as not_run with its reason instead.

export class MissingRpcUrl extends Error {
  override readonly name = "MissingRpcUrl";
}

export class ChainIdMismatch extends Error {
  override readonly name = "ChainIdMismatch";
}

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export class SourceMismatch extends Error {
  override readonly name = "SourceMismatch";
}
