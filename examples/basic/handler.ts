interface LambdaEvent {
    httpMethod?: string;
    path?: string;
    body?: string;
    queryStringParameters?: Record<string, string>;
    headers?: Record<string, string>;
}

interface LambdaContext {
    awsRequestId: string;
    functionName: string;
    getRemainingTimeInMillis: () => number;
}

export const handler = async (event: LambdaEvent, context: LambdaContext) => {
    console.log(`Request ${context.awsRequestId} received`);

    return {
        statusCode: 200,
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({
            message: "Hello from Bun on Lambda! 🐰",
            bunVersion: Bun.version,
            requestId: context.awsRequestId,
            timestamp: new Date().toISOString(),
        }),
    };
};