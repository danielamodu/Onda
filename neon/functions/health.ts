export default {
  fetch(request: Request): Response {
    if (request.method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }

    const { pathname } = new URL(request.url);
    if (pathname !== "/" && pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }

    return Response.json(
      { service: "onda", status: "ok" },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
};
