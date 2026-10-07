// Every way a maker run can fail has its own name.

export class MakerError extends Error {}

export class MissingSetting extends MakerError {
  override readonly name = "MissingSetting";
}
export class BadSetting extends MakerError {
  override readonly name = "BadSetting";
}
