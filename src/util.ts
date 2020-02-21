import debug from "debug";
import {
  of,
  Observable,
  ObservableInput,
  OperatorFunction,
  MonoTypeOperatorFunction,
  pipe,
} from "rxjs";
import { switchMap, mergeScan, tap, retryWhen, delay } from "rxjs/operators";

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

export type PromiseFactory<T> = () => Promise<T>;

/**
 * Wrap a function that returns a promise into a retryable observable that
 * emits a single value.
 */
export const promiseFactoryToObservable = <T>(
  promiseFactory: PromiseFactory<T>,
): Observable<T> => of(undefined).pipe(switchMap(promiseFactory));

/**
 * mergeScan with a concurrency level of 1 (i.e. switchScan)
 */
export const switchScan = <T, R>(
  accumulator: (acc: R, value: T, index: number) => ObservableInput<R>,
  seed: R,
): OperatorFunction<T, R> => mergeScan(accumulator, seed, 1);

/**
 * Log stream errors with `logFormat` and retry the observable after `retryAfterSeconds`.
 */
export const logErrorAndRetry = <T>(
  logFormat: string,
  retryAfterSeconds: number,
): MonoTypeOperatorFunction<T> =>
  pipe(
    tap(null, error => {
      console.warn(logFormat, error);
    }),
    retryWhen(e => e.pipe(delay(retryAfterSeconds))),
  );
