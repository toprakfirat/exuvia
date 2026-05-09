// Tiny proxy between openclaw and Ollama. Listens on 11435, forwards to
// 11434, logs every request body so we can see what tools (if any)
// openclaw is sending. Disposable — delete when done debugging.
import http from "node:http";

const UPSTREAM = { host: "127.0.0.1", port: 11434 };

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);

    if (req.url === "/api/chat" && req.method === "POST") {
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        console.log(
          `\n=== /api/chat ${new Date().toISOString()} ===`,
        );
        console.log(`model: ${parsed.model}`);
        console.log(
          `tools: ${Array.isArray(parsed.tools) ? parsed.tools.length : "none"}` +
            (Array.isArray(parsed.tools) && parsed.tools.length
              ? ` (${parsed.tools.map((t) => t.function?.name ?? t.name ?? "?").join(", ")})`
              : ""),
        );
        console.log(`stream: ${parsed.stream}`);
        console.log(`messages (${parsed.messages?.length ?? 0}):`);
        for (const [i, m] of (parsed.messages ?? []).entries()) {
          const c =
            typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content);
          // Truncate long system blobs but keep user/assistant turns intact.
          const max = m.role === "system" ? 600 : 2000;
          const shown = c.length > max ? c.slice(0, max) + ` …[+${c.length - max}]` : c;
          console.log(`  [${i}] ${m.role}: ${shown.replace(/\n/g, "\\n")}`);
        }
      } catch (err) {
        console.log("could not parse /api/chat body:", err.message);
      }
    }

    const proxyReq = http.request(
      {
        host: UPSTREAM.host,
        port: UPSTREAM.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${UPSTREAM.host}:${UPSTREAM.port}` },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", (err) => {
      console.log("upstream error:", err.message);
      res.writeHead(502).end(err.message);
    });
    proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(11435, "127.0.0.1", () => {
  console.log("ollama proxy: 127.0.0.1:11435 → 127.0.0.1:11434");
});
