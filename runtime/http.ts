/**
 * Bun Lambda Runtime — HTTP Event Adapter
 *
 * Lambda delivers HTTP as a JSON event, not a socket. This turns the three
 * HTTP event shapes — Function URL / HTTP API (payload 2.0), REST API
 * (payload 1.0) and ALB — into a `Request`, and a `Response` back into the
 * proxy result each of them expects.
 *
 * @see https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html
 * @see https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @see https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html
 */

type AnyEvent = Record<string, any>;
export type HttpEventKind = "apigw-v2" | "apigw-v1" | "alb";

// decode() without { stream: true } resets the decoder at the end of every call, so a single instance is safe to reuse — and constructing one per response is not free.
const UTF8 = new TextDecoder("utf-8", { fatal: true });

// Content types that survive the Runtime API as text; everything else goes base64.
const TEXT_CONTENT_TYPE = /^(?:text\/|application\/(?:json|javascript|ecmascript|xml|xhtml\+xml|x-ndjson|graphql|x-www-form-urlencoded)|image\/svg\+xml|[\w.-]+\/[\w.-]+\+(?:json|xml))/i;

/**
 * Classify an event, or `null` for everything else (SQS, S3, EventBridge, ...).
 *
 * Every real HTTP event carries a `requestContext`, and requiring it keeps a hand-written `{"httpMethod":"GET","path":"/"}` off the HTTP path.
 */
export function detectHttpEvent(event: unknown): HttpEventKind | null {
    if (!event || typeof event !== "object" || Array.isArray(event)) return null;

    const e = event as AnyEvent;
    const requestContext = e.requestContext;
    if (!requestContext || typeof requestContext !== "object") return null;

    if (e.version === "2.0" && requestContext.http && typeof requestContext.http.method === "string") return "apigw-v2";

    if (typeof e.httpMethod !== "string") return null;
    if (requestContext.elb) return "alb";
    if (typeof e.path === "string") return "apigw-v1";

    return null;
};

/** Rules an event out without parsing it — no `requestContext`, no adaptation. */
export function mayBeHttpEvent(rawEvent: string): boolean {
    return rawEvent.includes("\"requestContext\"");
};

/**
 * A map only counts as present once it has an entry.
 *
 * Proxies that send `"multiValueHeaders": {}` alongside a populated `headers` are common, and letting the empty map win drops every header — including Host, which the URL is rebuilt from.
 */
function hasEntries(value: unknown): boolean {
    return !!value && typeof value === "object" && Object.keys(value).length > 0;
};

function appendHeaders(headers: Headers, single: unknown, multi: unknown): void {
    // multiValueHeaders is the same data with duplicates kept, so it wins outright — reading both maps would send every header twice.
    if (hasEntries(multi)) {
        for (const [name, values] of Object.entries(multi as Record<string, unknown>)) {
            if (!Array.isArray(values)) continue;

            for (const value of values)
                if (value != null) headers.append(name, String(value));
        };

        return;
    };

    if (single && typeof single === "object")
        for (const [name, value] of Object.entries(single as Record<string, unknown>))
            if (value != null) headers.append(name, String(value));
};

function queryFromParameters(single: unknown, multi: unknown, preEncoded: boolean): string {
    const parts: string[] = [];

    // ALB parameters arrive percent-encoded; API Gateway decodes them first.
    const push = (name: string, value: unknown) => {
        if (value == null) return;

        parts.push(preEncoded ? `${name}=${String(value)}` : `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    };

    if (hasEntries(multi)) {
        for (const [name, values] of Object.entries(multi as Record<string, unknown>))
            if (Array.isArray(values)) for (const value of values) push(name, value);
    } else if (single && typeof single === "object")
        for (const [name, value] of Object.entries(single as Record<string, unknown>)) push(name, value);

    return parts.join("&");
};

function decodeBody(event: AnyEvent, method: string): BodyInit | undefined {
    if (event.body == null || event.body === "") return undefined;

    // `new Request` throws on a GET/HEAD body, and a proxy that sends one is not worth crashing over.
    if (method === "GET" || method === "HEAD") return undefined;

    return event.isBase64Encoded ? Buffer.from(String(event.body), "base64") : String(event.body);
};

/**
 * Re-encode a decoded path.
 *
 * API Gateway payload 1.0 hands over `path` already URL-decoded, so a literal "#" would cut the rest of the path off as a fragment and a "?" would turn it into a query string.
 * Payload 2.0's `rawPath` and ALB's `path` arrive still encoded, and are used as they are.
 */
function encodePath(path: string): string {
    // encodeURIComponent escapes "/" as well, so the segments are encoded one at a time.
    return path.split("/").map(segment => encodeURIComponent(segment)).join("/");
};

/** `Headers.get` comma-joins repeats, and `https, http` from a chained proxy — or a duplicated Host — makes an unparseable URL that would fail the whole invocation. */
function firstValue(headers: Headers, name: string): string | null {
    const value = headers.get(name);
    if (value === null) return null;

    const comma = value.indexOf(",");
    return (comma === -1 ? value : value.slice(0, comma)).trim();
};

/**
 * Build a `Request` from an HTTP event, rebuilding the absolute URL from the Host header (or the API domain) so `new URL(request.url)` and URL-matching routers see what the client asked for.
 */
export function toRequest(kind: HttpEventKind, event: AnyEvent, requestId: string): Request {
    const requestContext = (event.requestContext ?? {}) as AnyEvent;
    const method: string = kind === "apigw-v2" ? String(requestContext.http?.method ?? "GET") : String(event.httpMethod ?? "GET");

    const headers = new Headers();
    appendHeaders(headers, event.headers, kind === "apigw-v2" ? undefined : event.multiValueHeaders);

    let path: string, query: string;

    if (kind === "apigw-v2") {
        path = String(event.rawPath ?? requestContext.http?.path ?? "/");
        query = String(event.rawQueryString ?? "");

        // Payload 2.0 lifts cookies out of the headers; put them back.
        if (Array.isArray(event.cookies) && event.cookies.length > 0) headers.set("cookie", event.cookies.join("; "));
    } else {
        path = kind === "alb" ? String(event.path ?? "/") : encodePath(String(event.path ?? "/"));
        query = queryFromParameters(event.queryStringParameters, event.multiValueQueryStringParameters, kind === "alb");
    };

    if (!path.startsWith("/")) path = `/${path}`;
    if (!headers.has("x-amzn-requestid")) headers.set("x-amzn-requestid", requestId);

    const body = decodeBody(event, method);

    // The event's Content-Length describes a body that is not being forwarded, so leaving it in would only mislead the handler.
    if (body === undefined) headers.delete("content-length");

    const host = firstValue(headers, "host") || String(requestContext.domainName ?? "lambda.local");
    const protocol = firstValue(headers, "x-forwarded-proto") || "https";

    return new Request(`${protocol}://${host}${path}${query ? `?${query}` : ""}`, { method, headers, body });
};

function encodeBody(bytes: Buffer, contentType: string | null, compressed: boolean): { body: string; isBase64Encoded: boolean } {
    if (bytes.length === 0) return { body: "", isBase64Encoded: false };

    // An untyped body gets the benefit of the doubt — the fatal decoder catches the bytes that are not really text.
    if (!compressed && (contentType === null || TEXT_CONTENT_TYPE.test(contentType)))
        try {
            return { body: UTF8.decode(bytes), isBase64Encoded: false };
        } catch { };

    return { body: bytes.toString("base64"), isBase64Encoded: true };
};

/**
 * Headers that frame the `Response` we just consumed rather than the payload the proxy will send.
 *
 * Content-Length is the dangerous one: base64 changes the payload's length, and a Response piped straight from an upstream `fetch` reports the *compressed* length against bytes the runtime has already decompressed — either way the proxy answers with a truncated body or a 502.
 * Content-Encoding is deliberately kept: a handler returning pre-compressed bytes needs it, and it still forces the base64 path below.
 */
const FRAMING_HEADERS = new Set(["set-cookie", "content-length", "transfer-encoding", "connection", "keep-alive"]);

/** Turn a `Response` back into the proxy result shape for this event kind. */
export async function fromResponse(kind: HttpEventKind, response: Response): Promise<Record<string, unknown>> {
    // Buffer.from(ArrayBuffer) is a view over the same memory, so the body is never copied on its way to base64.
    const bytes = Buffer.from(await response.arrayBuffer());

    // Header iteration yields lowercased names, so these compare directly.
    const headers: Record<string, string> = {};
    for (const [name, value] of response.headers)
        if (!FRAMING_HEADERS.has(name)) headers[name] = value;

    // Iterating Headers comma-joins repeated set-cookie values into one header no browser can unpick, so they come off with getSetCookie().
    const setCookie = response.headers.get("set-cookie");
    const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : (setCookie ? [setCookie] : []);

    const { body, isBase64Encoded } = encodeBody(bytes, response.headers.get("content-type"), response.headers.has("content-encoding"));
    const result: Record<string, unknown> = { statusCode: response.status, headers, body, isBase64Encoded };

    if (kind === "apigw-v2") {
        if (cookies.length > 0) result.cookies = cookies;
        return result;
    };

    // v1 and ALB have no cookie array. A lone cookie goes in the single-value map every target group accepts;
    // only genuinely repeated Set-Cookie headers need multiValueHeaders, which an ALB target group answers with a 502 unless multi-value headers are enabled on it.
    if (cookies.length === 1)
        headers["set-cookie"] = cookies[0]!;
    else if (cookies.length > 1)
        result.multiValueHeaders = { "set-cookie": cookies };

    // A Response only carries a reason phrase if the handler set one; without it ALB fills in the standard phrase itself.
    if (kind === "alb" && response.statusText) result.statusDescription = `${response.status} ${response.statusText}`;

    return result;
};