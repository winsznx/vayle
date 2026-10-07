// Every way a maker run can fail has its own name.

export class MakerError extends Error {}

export class MissingSetting extends MakerError {
  override readonly name = "MissingSetting";
}
export class BadSetting extends MakerError {
  override readonly name = "BadSetting";
}
export class DigestMismatch extends MakerError {
  override readonly name = "DigestMismatch";
}
export class CalendarNotCovered extends MakerError {
  override readonly name = "CalendarNotCovered";
}
