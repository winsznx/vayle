// Every way a keeper run can fail has its own name.

export class KeeperError extends Error {}

export class MissingSetting extends KeeperError {
  override readonly name = "MissingSetting";
}
