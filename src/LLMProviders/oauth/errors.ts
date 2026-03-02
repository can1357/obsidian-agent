/**
 * Error thrown when user cancels an OAuth flow or auth gets reset while async work is in-flight.
 */
export class OAuthAuthCancelledError extends Error {
  readonly name = "OAuthAuthCancelledError";

  constructor(message = "Authentication cancelled by user.") {
    super(message);
    Object.setPrototypeOf(this, OAuthAuthCancelledError.prototype);
  }
}

/**
 * Type guard for OAuthAuthCancelledError.
 * @param error - Unknown error value.
 * @returns True when the value is an OAuthAuthCancelledError.
 */
export function isOAuthAuthCancelledError(error: unknown): error is OAuthAuthCancelledError {
  return (
    error instanceof OAuthAuthCancelledError ||
    (error instanceof Error && error.name === "OAuthAuthCancelledError")
  );
}
