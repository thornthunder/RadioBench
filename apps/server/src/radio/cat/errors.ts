/** The radio rejected a command or answered with something unexpected. */
export class CatError extends Error {
  override name = 'CatError';
}

/**
 * A command that cannot be carried out for a reason the person who gave it should be told,
 * in the words of its message. The link to the radio is not at fault.
 */
export class CommandError extends Error {
  override name = 'CommandError';
}

/** The radio did not answer a read command in time. */
export class CatTimeoutError extends CatError {
  override name = 'CatTimeoutError';
}
