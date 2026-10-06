// Every way a resolution can fail has its own name, so a failed run says exactly what didn't hold.
// Nothing falls back to a default value.

export class FactError extends Error {}

export class MissingRpcUrl extends FactError {
  override readonly name = "MissingRpcUrl";
}
export class SourceFetchFailed extends FactError {
  override readonly name = "SourceFetchFailed";
}
export class ChainIdMismatch extends FactError {
  override readonly name = "ChainIdMismatch";
}
export class AssetNotListed extends FactError {
  override readonly name = "AssetNotListed";
}
export class AssetNotActive extends FactError {
  override readonly name = "AssetNotActive";
}
export class UidMismatch extends FactError {
  override readonly name = "UidMismatch";
}
export class DecimalsMismatch extends FactError {
  override readonly name = "DecimalsMismatch";
}
export class InterfaceNotSupported extends FactError {
  override readonly name = "InterfaceNotSupported";
}
export class AmbiguousAddress extends FactError {
  override readonly name = "AmbiguousAddress";
}
export class DomainMismatch extends FactError {
  override readonly name = "DomainMismatch";
}
export class FeedNotListed extends FactError {
  override readonly name = "FeedNotListed";
}
export class FeedMismatch extends FactError {
  override readonly name = "FeedMismatch";
}
export class NonPositiveAnswer extends FactError {
  override readonly name = "NonPositiveAnswer";
}
export class SpecMismatch extends FactError {
  override readonly name = "SpecMismatch";
}
export class Drift extends FactError {
  override readonly name = "Drift";
}
export class CodeSizeProbeFailed extends FactError {
  override readonly name = "CodeSizeProbeFailed";
}
