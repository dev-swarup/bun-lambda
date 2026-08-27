export default {
    async fetch(request: Request): Promise<Response> {
        const event = await request.json();

        return new Response(JSON.stringify({
            event, version: Bun.version,
            message: "Hello from Bun fetch handler on Lambda! 🐰",
            timestamp: new Date().toISOString()
        }),
            {
                status: 200,
                headers: {
                    "content-type": "application/json",
                }
            });
    }
};