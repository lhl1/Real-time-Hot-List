import { getHotResponse } from "../src/hotService.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const url = new URL(req.url, "http://localhost");
    const force = url.searchParams.get("refresh") === "1";
    sendJson(res, 200, await getHotResponse({ force }));
  } catch (error) {
    sendJson(res, 500, {
      updatedAt: new Date().toISOString(),
      sources: { baidu: "error", weibo: "error", zhihu: "error" },
      items: [],
      rawItems: [],
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
