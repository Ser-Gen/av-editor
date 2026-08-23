/**
 * The one string that means "the disk is full", shared by the worker that discovers it and
 * the session that has to act on it.
 *
 * It crosses a `postMessage` boundary, so it cannot be an exception type — but it should not
 * be two string literals in two files either.
 */
export const OUT_OF_SPACE = 'out of storage space';
