/**
 * Bun Lambda Runtime — Lambda Runtime API Loop
 *
 * Pre-compiled with `bun build --compile --bytecode` for maximum cold start performance. 
 * The compiled binary serves as the Lambda `bootstrap` executable directly — no shell script, no separate Bun binary, no TypeScript parsing at startup.
 *
 * @see https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html
 */

import { detectHttpEvent, fromResponse, mayBeHttpEvent, toRequest, type HttpEventKind } from "./http";

// Lambda fixes these for the life of the execution environment, so they are read once at module load instead of on every trip round the loop.
const ENV = {
    functionName: Bun.env.AWS_LAMBDA_FUNCTION_NAME ?? "",
    functionVersion: Bun.env.AWS_LAMBDA_FUNCTION_VERSION ?? "$LATEST",
    memoryLimitInMB: Bun.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? "",
    logGroupName: Bun.env.AWS_LAMBDA_LOG_GROUP_NAME ?? "",
    logStreamName: Bun.env.AWS_LAMBDA_LOG_STREAM_NAME ?? ""
};

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

// Second argument to a fetch handler; `event` is set when the runtime had to parse the event anyway, i.e. on every adapted HTTP invocation.
interface FetchContext extends LambdaContext {
    event?: unknown;
}

type FetchHandler = (request: Request, context: FetchContext) => Promise<Response> | Response;

interface FetchStyleHandler {
    fetch: FetchHandler;
}

// A handler's result is either:
//   - `raw`   already-serialized text (a fetch handler's Response body).
//             Posted to the Runtime API byte-for-byte, no re-encoding.
//   - `value` an arbitrary JS value (a classic handler's return value).
//             JSON.stringify'd once, right before it goes on the wire.
type InvokeResult = { raw: string } | { value: unknown };

interface ResolvedHandler {
    mode: "fetch" | "classic" | "fetch+classic";
    invoke: (rawEvent: string, context: LambdaContext) => Promise<InvokeResult>;
}

/**
 * Pick out whichever handlers the module exposes: a fetch handler (`export default { fetch }`, `export function fetch`, or a named export with a `fetch` method) and a classic one (`handler`, or a default export function).
 * A named export claims its own kind; the other is still taken from the module's conventional exports, so both can live in one module.
 */
function selectExports(mod: Record<string, unknown>, exportName?: string): { fetchFn?: FetchHandler; classicFn?: ClassicHandler } {
    let fetchFn: FetchHandler | undefined;
    let classicFn: ClassicHandler | undefined;

    if (exportName && mod[exportName] !== undefined) {
        const exported = mod[exportName];

        // Any object with a fetch method is fetch-style, whatever it is called.
        if (exported && typeof exported === "object" && typeof (exported as FetchStyleHandler).fetch === "function")
            fetchFn = (exported as FetchStyleHandler).fetch.bind(exported);
        else if (typeof exported === "function") {
            // "src/app.fetch" — a handler named fetch takes a Request, not (event, context).
            if (exportName === "fetch")
                fetchFn = exported as FetchHandler;
            else
                classicFn = exported as ClassicHandler;
        } else throw new Error(`Export "${exportName}" is a ${typeof exported}, not a handler function or an object with a "fetch" method.`);
    };

    if (!fetchFn) {
        if (typeof mod.fetch === "function")
            fetchFn = mod.fetch as FetchHandler;
        else if (mod.default && typeof mod.default === "object" && typeof (mod.default as FetchStyleHandler).fetch === "function")
            fetchFn = (mod.default as FetchStyleHandler).fetch.bind(mod.default);
    };

    if (!classicFn) {
        if (typeof mod.handler === "function")
            classicFn = mod.handler as ClassicHandler;
        else if (typeof mod.default === "function")
            classicFn = mod.default as ClassicHandler;
    };

    return { fetchFn, classicFn };
};

/**
 * Bind the module's exports to an invocation strategy.
 *
 * `bun build --compile` bundles the handler module at compile time, so the generated entry point imports it statically and hands it over here — no dynamic import() at runtime. 
 * `rawEvent` is the invocation body as the Runtime API sent it, parsed only as far as the chosen strategy needs.
 */
function resolveHandler(mod: Record<string, unknown>, exportName?: string): ResolvedHandler {
    const { fetchFn, classicFn } = selectExports(mod, exportName);

    // Both in one module: the event shape decides which one runs.
    if (fetchFn && classicFn)
        return {
            mode: "fetch+classic",
            invoke: async (rawEvent, context) => {
                const event = parseEvent(rawEvent);
                const kind = detectHttpEvent(event);

                return kind ? invokeHttpHandler(fetchFn, kind, event, context) : { value: await classicFn(event, context) };
            }
        };

    if (fetchFn)
        return {
            mode: "fetch",
            invoke: (rawEvent, context) => invokeFetchHandler(fetchFn, rawEvent, context)
        };

    if (classicFn)
        return {
            mode: "classic",
            invoke: async (rawEvent, context) => ({ value: await classicFn(parseEvent(rawEvent), context) })
        };

    throw new Error(`Could not resolve handler from module. Expected a named export "${exportName || "handler"}", a default export function, or a "fetch" export (module-level or on the default export).`);
};

function parseEvent(rawEvent: string): unknown {
    // Scan for the first non-whitespace byte rather than rawEvent.trim(), which copies the whole (up to 6 MB) payload just to answer "is it blank?".
    for (let i = 0; i < rawEvent.length; i++) {
        const code = rawEvent.charCodeAt(i);

        // JSON whitespace is exactly space, tab, LF and CR.
        if (code !== 32 && code !== 9 && code !== 10 && code !== 13) return JSON.parse(rawEvent);
    };

    return {};
};

/** The adapter path: event in as a `Request`, proxy result out of a `Response`. */
async function invokeHttpHandler(fetchFn: FetchHandler, kind: HttpEventKind, event: unknown, context: LambdaContext): Promise<InvokeResult> {
    const request = toRequest(kind, event as Record<string, any>, context.awsRequestId);

    // The context is built fresh for this invocation, so it can carry the parsed event without spreading a copy of it.
    (context as FetchContext).event = event;
    return { value: await fromResponse(kind, await fetchFn(request, context)) };
};

async function invokeFetchHandler(fetchFn: FetchHandler, rawEvent: string, context: LambdaContext): Promise<InvokeResult> {
    if (mayBeHttpEvent(rawEvent)) {
        const event = parseEvent(rawEvent);
        const kind = detectHttpEvent(event);

        if (kind) return invokeHttpHandler(fetchFn, kind, event, context);
    };

    // Not HTTP: the event is the request body, and the response body is posted back byte for byte.
    const request = new Request(`https://lambda.local/${context.awsRequestId}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-amzn-requestid": context.awsRequestId,
            "x-amzn-function-arn": context.invokedFunctionArn,
        },
        body: rawEvent
    });

    const response = await fetchFn(request, context);
    const raw = await response.text();

    // A bodiless Response (204, `new Response(null)`) would otherwise post nothing at all, leaving the caller a zero-byte payload where JSON is expected.
    return { raw: raw || "null" };
};

/**
 * Build the invocation context from the Runtime API response headers.
 * Everything that is fixed for the life of the execution environment comes from the environment; only the per-invocation values come off the headers.
 *
 * @see https://docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html#runtimes-api-next
 */
function buildContext(headers: Headers): LambdaContext {
    const deadlineMs = Number(headers.get("lambda-runtime-deadline-ms")) || 0;

    // X-Ray reads the active trace out of the environment, and it changes on every invocation — so it has to be refreshed each time round the loop.
    const traceId = headers.get("lambda-runtime-trace-id");

    if (traceId)
        process.env._X_AMZN_TRACE_ID = traceId;
    else
        delete process.env._X_AMZN_TRACE_ID;

    return {
        awsRequestId: headers.get("lambda-runtime-aws-request-id") ?? "",
        invokedFunctionArn: headers.get("lambda-runtime-invoked-function-arn") ?? "",
        functionName: ENV.functionName,
        functionVersion: ENV.functionVersion,
        memoryLimitInMB: ENV.memoryLimitInMB,
        logGroupName: ENV.logGroupName,
        logStreamName: ENV.logStreamName,
        deadlineMs, getRemainingTimeInMillis: () => Math.max(0, deadlineMs - Date.now())
    };
};

function runtimeApiBaseUrl(): string {
    const api = Bun.env.AWS_LAMBDA_RUNTIME_API;
    if (!api) throw new Error("AWS_LAMBDA_RUNTIME_API is not set. This binary must run inside the Lambda execution environment.");

    return `http://${api}/2018-06-01`;
};

// The invocation currently being served. A crash that escapes the handler's promise chain has no other way to name the request it belongs to.
let inFlightRequestId: string | undefined;

/**
 * Trap the failures that never reach the invocation's `catch`: a throw inside a `setTimeout` callback, an unawaited promise that rejects, an "error" event with no listener.
 *
 * Bun tears the process down for these, and Lambda simply never hears back — the invocation hangs until the function's configured timeout, billed in full, and the caller waits minutes for what was an immediate error.
 * Reporting first turns that into a normal error response. This is what the managed Node runtime does too.
 */
function installCrashHandlers(baseUrl: string): void {
    const fatal = (errorType: string) => async (err: unknown): Promise<void> => {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`[lambda] ${errorType}:`, error);

        const requestId = inFlightRequestId;
        inFlightRequestId = undefined;

        if (requestId)
            try {
                await reportError(`${baseUrl}/runtime/invocation/${requestId}/error`, error, errorType);
            } catch (reportErr) { console.error("[lambda] Failed to report fatal error:", reportErr); };

        // Whatever state the crash left behind is not worth reusing; exiting has Lambda build a fresh execution environment for the next invocation.
        process.exit(1);
    };

    process.on("uncaughtException", fatal("Runtime.UncaughtException"));
    process.on("unhandledRejection", fatal("Runtime.UnhandledRejection"));
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

    installCrashHandlers(baseUrl);

    // Initialization phase
    let handler: ResolvedHandler;

    try {
        handler = resolveHandler(mod, exportName);
        console.log(`[lambda] Runtime ready (compiled bytecode, ${handler.mode} handler)`);
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

            // No invocation was handed out, so there is nothing to run and nothing to report an error against.
            // Drain the body to free the connection and back off, rather than invoking the handler on a failure payload.
            if (!nextResponse.ok || !context.awsRequestId) {
                console.error(`[lambda] Runtime API /next returned ${nextResponse.status} ${nextResponse.statusText}${context.awsRequestId ? "" : " with no request id"}`);
                await nextResponse.text();
                await Bun.sleep(100);
                continue;
            };

            requestId = context.awsRequestId;
            inFlightRequestId = requestId;

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
                    // Reporting failed too. Log and move on to the next invocation — one bad round trip should never take down the whole runtime.
                    console.error("[lambda] Failed to report invocation error:", reportErr);
                }
            else {
                // We failed before getting a request id (e.g. the Runtime API itself was unreachable).
                // There's nothing to report against, so back off briefly instead of hammering it in a tight loop.
                await Bun.sleep(250);
            };
        } finally {
            // This invocation is settled either way, so a later crash must not be reported against it.
            inFlightRequestId = undefined;
        };
    };
};