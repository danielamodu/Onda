export class SettlementConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementConfigurationError";
  }
}
