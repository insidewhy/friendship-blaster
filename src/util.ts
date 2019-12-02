import debug from "debug";
import { of, Observable } from "rxjs";
import { switchMap } from "rxjs/operators";

/**
 * Returns true if the argument is defined and narrows the type accordingly.
 */
export const isDefined = <T>(val: T | undefined): val is T => !!val;

/**
 * Logs that are hidden unless the `DEBUG` environment variable is set to
 * `friendship-blaster` or equivalent. See the npm package `debug` for more
 * information.
 */
export const debugLog = debug("friendship-blaster");

/**
 * Wrap a function that returns a promise into a retryable observable that
 * emits a single value.
 */
export const promiseFactoryToObservable = <T>(
  promiseFactory: () => Promise<T>,
): Observable<T> =>
  of(undefined).pipe(
    // ensure the pull will be retried until it succeeds or until a new
    // configuration has been detected
    switchMap(promiseFactory),
  );
