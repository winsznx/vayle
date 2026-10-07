export class MissingSetting extends Error {
  override readonly name = "MissingSetting";
}

export class AnvilDidNotStart extends Error {
  override readonly name = "AnvilDidNotStart";
}

export class ForkNotRunning extends Error {
  override readonly name = "ForkNotRunning";
}

export class DeployFailed extends Error {
  override readonly name = "DeployFailed";
}

export class FundingSourceShort extends Error {
  override readonly name = "FundingSourceShort";
}
