/**
 * Bun Lambda Runtime — Lambda Runtime API Loop
 *
 * Pre-compiled with `bun build --compile --bytecode` for maximum
 * cold start performance. The compiled binary serves as the Lambda
 * `bootstrap` executable directly — no shell script, no separate
 * Bun binary, no TypeScript parsing at startup.
 *
 * @see https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LambdaContext {
    functionName: string;
    functionVersion: string;
    invokedFunctionArn: string;
    memoryLimitInMB: string;
    awsRequestId: string;
    logGroupName: string;
    logStreamName: string;
    deadlineMs: number;
    getRemainingTimeInMillis: () => number;
}

type ClassicHandler = (event: unknown, context: LambdaContext) => Promise<unknown>;

interface FetchStyleHandler {
    fetch: (request: Request) => Promise<Response> | Response;
}

// A handler's result is either:
//   - `raw`   already-serialized text (a fetch handler's Response body).
//             Posted to the Runtime API byte-for-byte, no re-encoding.
//   - `value` an arbitrary JS value (a classic handler's return value).
//             JSON.stringify'd once, right before it goes on the wire.
type InvokeResult = { raw: string } | { value: unknown };

interface ResolvedHandler {
    invoke: (rawEvent: string, context: LambdaContext) => Promise<InvokeResult>;
}

// ---------------------------------------------------------------------------
// Handler Resolution (from pre-imported module)
// ---------------------------------------------------------------------------

/**
 * Resolve a handler from an already-imported module.
 *
 * Since `bun build --compile` bundles all imports at compile time,
 * the user's handler module is statically imported by the generated
 * entry point and passed here. No dynamic import() needed at runtime.
 *
 * Supports:
 *   - Named export function (e.g. `export const handler = ...`)
 *   - Default export function (e.g. `export default async (event) => ...`)
 *   - Default export with fetch method (e.g. `export default { fetch(req) { ... } }`)
 *   - Module-level fetch export (e.g. `export function fetch(req) { ... }`)
 *
 * Each invocation's body arrives as `rawEvent`, the exact text the Lambda
 * Runtime API sent us — already valid JSON, since that's the invoke contract.
 * Classic handlers need it parsed into an object, so we parse it once here.
 * Fetch-style handlers just want a body to hand to `Request`, so we pass
 * `rawEvent` straight through with no parse/stringify round trip.
 */
function resolveHandler(mod: Record<string, unknown>, exportName?: string): ResolvedHandler {
    // Case 1: Explicit named export (e.g. "handler")
    if (exportName && mod[exportName] !== undefined) {
        const exported = mod[exportName];

        // `export const app = { fetch(req) { ... } }` — an object exposing
        // fetch is a fetch-style handler, whatever the export is called.
        if (exported && typeof exported === "object" && typeof (exported as FetchStyleHandler).fetch === "function") {
            const fetchFn = (exported as FetchStyleHandler).fetch.bind(exported);
            return { invoke: (rawEvent, context) => invokeFetchHandler(fetchFn, rawEvent, context) };
        };

        if (typeof exported === "function") {
            // A handler named `fetch` takes a Request, not (event, context) —
            // this is the "src/app.fetch" form.
            if (exportName === "fetch") {
                const fetchFn = exported as FetchStyleHandler["fetch"];
                return { invoke: (rawEvent, context) => invokeFetchHandler(fetchFn, rawEvent, context) };
            };

            const fn = exported as ClassicHandler;
            return {
                invoke: async (rawEvent, context) => {
                    const parsed = rawEvent && rawEvent.trim() ? JSON.parse(rawEvent) : {};
                    return { value: await fn(parsed, context) };
                }
            };
        };

        throw new Error(`Export "${exportName}" is a ${typeof exported}, not a handler function or an object with a "fetch" method.`);
    };

    // Case 2: Default export is a function (classic handler as default)
    if (typeof mod.default === "function") {
        const fn = mod.default as ClassicHandler;
        return {
            invoke: async (rawEvent, context) => {
                const parsed = rawEvent && rawEvent.trim() ? JSON.parse(rawEvent) : {};
                return { value: await fn(parsed, context) };
            }
        };
    };

    // Case 3: Default export has a `fetch` method (Bun fetch-style handler)
    if (mod.default && typeof mod.default === "object" && typeof (mod.default as FetchStyleHandler).fetch === "function") {
        const fetchHandler = mod.default as FetchStyleHandler;
        return {
            invoke: (rawEvent, context) => invokeFetchHandler(fetchHandler.fetch, rawEvent, context)
        };
    };

    // Case 4: Module-level `fetch` export
    if (typeof mod.fetch === "function") {
        const fetchFn = mod.fetch as FetchStyleHandler["fetch"];
        return {
            invoke: (rawEvent, context) => invokeFetchHandler(fetchFn, rawEvent, context)
        };
    };

    throw new Error(`Could not resolve handler from module. Expected a named export "${exportName || "handler"}", a default export function, or a default export with a "fetch" method.`);
};

async function invokeFetchHandler(fetchFn: FetchStyleHandler["fetch"], rawEvent: string, context: LambdaContext): Promise<InvokeResult> {
    const request = new Request(`https://lambda.local/${context.awsRequestId}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-amzn-requestid": context.awsRequestId,
            "x-amzn-function-arn": context.invokedFunctionArn,
        },
        body: rawEvent
    });

    const response = await fetchFn(request);
    const raw = await response.text();
    return { raw };
};

// ---------------------------------------------------------------------------
// Runtime API helpers
// ---------------------------------------------------------------------------

/**
 * Build the invocation context from the Runtime API response headers.
 *
 * Everything that is fixed for the life of the execution environment comes
 * from the environment; only the per-invocation values come off the headers.
 *
 * @see https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html#runtimes-api-next
 */
function buildContext(headers: Headers): LambdaContext {
    const deadlineMs = Number(headers.get("lambda-runtime-deadline-ms")) || 0;

    // X-Ray reads the active trace out of the environment, and it changes on
    // every invocation — so it has to be refreshed each time round the loop.
    const traceId = headers.get("lambda-runtime-trace-id");

    if (traceId)
        process.env._X_AMZN_TRACE_ID = traceId;
    else
        delete process.env._X_AMZN_TRACE_ID;

    return {
        awsRequestId: headers.get("lambda-runtime-aws-request-id") ?? "",
        invokedFunctionArn: headers.get("lambda-runtime-invoked-function-arn") ?? "",
        functionName: Bun.env.AWS_LAMBDA_FUNCTION_NAME ?? "",
        functionVersion: Bun.env.AWS_LAMBDA_FUNCTION_VERSION ?? "$LATEST",
        memoryLimitInMB: Bun.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? "",
        logGroupName: Bun.env.AWS_LAMBDA_LOG_GROUP_NAME ?? "",
        logStreamName: Bun.env.AWS_LAMBDA_LOG_STREAM_NAME ?? "",
        deadlineMs, getRemainingTimeInMillis: () => Math.max(0, deadlineMs - Date.now())
    };
};

function runtimeApiBaseUrl(): string {
    const api = Bun.env.AWS_LAMBDA_RUNTIME_API;
    if (!api) throw new Error("AWS_LAMBDA_RUNTIME_API is not set. This binary must run inside the Lambda execution environment.");

    return `http://${api}/2018-06-01`;
};

async function reportError(url: string, error: Error, errorType: string = "Runtime.HandlerError"): Promise<void> {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "lambda-runtime-function-error-type": errorType,
        },
        body: JSON.stringify({
            errorMessage: error.message,
            errorType: error.name || errorType,
            stackTrace: error.stack?.split("\n") || [],
        })
    });

    if (!response.ok) console.error(`[lambda] Runtime API rejected error report: ${response.status} ${response.statusText}`);
};

// ---------------------------------------------------------------------------
// Public API — called from the generated entry point
// ---------------------------------------------------------------------------

/**
 * Start the Lambda Runtime API loop.
 *
 * @param mod - The pre-imported user handler module
 * @param exportName - The named export to use (e.g. "handler"). If omitted, uses default export.
 */
export async function startRuntime(mod: Record<string, unknown>, exportName?: string): Promise<never> {
    let baseUrl: string;
    try { baseUrl = runtimeApiBaseUrl(); } catch (err) {
        // No Runtime API to report to — nothing to do but log and stop.
        console.error(`[lambda] ${(err as Error).message}`);
        process.exit(1);
    };

    // Initialization phase
    let handler: ResolvedHandler;

    try {
        handler = resolveHandler(mod, exportName);
        console.log("[lambda] Runtime ready (compiled bytecode)");
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`[lambda] Failed to resolve handler:`, error);

        try {
            await reportError(`${baseUrl}/runtime/init/error`, error, "Runtime.InitError");
        } catch (reportErr) { console.error("[lambda] Failed to report init error:", reportErr); };

        process.exit(1);
    };

    // Invocation loop
    while (true) {
        let requestId: string | undefined;

        try {
            // 1. Get next invocation (blocks until an event is available)
            const nextResponse = await fetch(`${baseUrl}/runtime/invocation/next`);
            const context = buildContext(nextResponse.headers);
            requestId = context.awsRequestId;

            // Read the body once, as text. Classic handlers parse it themselves;
            // fetch-style handlers pass it straight through as their Request body.
            const rawEvent = await nextResponse.text();

            // 2. Invoke handler
            const result = await handler.invoke(rawEvent, context);
            const body = "raw" in result ? result.raw : JSON.stringify(result.value ?? null);

            // 3. Post response
            const postResponse = await fetch(`${baseUrl}/runtime/invocation/${requestId}/response`, {
                method: "POST",
                headers: {
                    "content-type": "application/json"
                },
                body
            });

            if (!postResponse.ok) console.error(`[lambda] Runtime API rejected response for ${requestId}: ${postResponse.status} ${postResponse.statusText}`);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            console.error(`[lambda] Invocation error (${requestId ?? "unknown"}):`, error);

            if (requestId)
                try {
                    await reportError(`${baseUrl}/runtime/invocation/${requestId}/error`, error);
                } catch (reportErr) {
                    // Reporting failed too. Log and move on to the next invocation —
                    // one bad round trip should never take down the whole runtime.
                    console.error("[lambda] Failed to report invocation error:", reportErr);
                }
            else {
                // We failed before getting a request id (e.g. the Runtime API itself
                // was unreachable). There's nothing to report against, so back off
                // briefly instead of hammering it in a tight loop.
                await Bun.sleep(250);
            };
        };
    };
};