/** Process exit codes. Stable, documented in the README, safe to script against. */
export const Exit = {
  ok: 0,
  failure: 1,
  usage: 2,
  notFound: 3,
  rateLimited: 4,
  noWget: 5,
  download: 6,
  verify: 7,
  interrupted: 130,
} as const;

export type ExitCode = (typeof Exit)[keyof typeof Exit];

/** An error we expect and know how to explain. Anything else is a bug. */
export class WgethubError extends Error {
  readonly code: ExitCode;
  readonly hint: string | undefined;

  constructor(message: string, code: ExitCode = Exit.failure, hint?: string) {
    super(message);
    this.name = "WgethubError";
    this.code = code;
    this.hint = hint;
  }
}

export class Interrupted extends WgethubError {
  constructor() {
    super("Interrupted.", Exit.interrupted);
    this.name = "Interrupted";
  }
}

/** Sleep that wakes up early (and rejects) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Interrupted());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Interrupted());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
