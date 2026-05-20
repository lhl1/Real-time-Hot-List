import dns from "node:dns";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

dns.setDefaultResultOrder("ipv4first");

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_BASES = ["https://api-hot.imsyy.top"];

const SOURCES = [
  { key: "baidu", label: "百度", type: "hot", path: "baidu", homeUrl: "https://top.baidu.com/board?tab=realtime" },
  { key: "weibo", label: "微博", type: "hot", path: "weibo", homeUrl: "https://s.weibo.com/top/summary" },
  { key: "zhihu", label: "知乎", type: "hot", path: "zhihu", homeUrl: "https://www.zhihu.com/hot" },
  {
    key: "ithome",
    label: "IT之家",
    type: "media",
    homeUrl: "https://www.ithome.com/",
    feeds: [
      "https://www.ithome.com/rss/",
    ],
  },
  { key: "gamersky", label: "游民星空", type: "hot", path: "gamersky", homeUrl: "https://www.gamersky.com/news/" },
  {
    key: "economist",
    label: "Economist",
    type: "media",
    homeUrl: "https://www.economist.com/international",
    feeds: [
      "https://www.economist.com/international/rss.xml",
    ],
  },
  {
    key: "reuters",
    label: "Reuters",
    type: "media",
    homeUrl: "https://www.reuters.com/world/",
    feeds: [
      "https://news.google.com/rss/search?q=site%3Areuters.com%2Fworld%2F&hl=en-US&gl=US&ceid=US:en",
    ],
  },
  {
    key: "ft",
    label: "Financial Times",
    type: "media",
    homeUrl: "https://www.ft.com/world",
    feeds: [
      "https://www.ft.com/world?format=rss",
    ],
  },
  {
    key: "bbc",
    label: "BBC",
    type: "media",
    homeUrl: "https://www.bbc.com/news/world",
    feeds: [
      "https://feeds.bbci.co.uk/news/world/rss.xml",
    ],
  },
];

let cache = null;
let refreshPromise = null;

export async function getHotResponse({ force = false } = {}) {
  if (!cache) {
    await startRefresh();
    return buildCachedResponse({ cached: false });
  }

  const stale = force || isCacheStale();
  if (stale) {
    startRefresh({ silent: true });
  }

  return buildCachedResponse({
    cached: true,
    stale,
    refreshing: stale || Boolean(refreshPromise),
  });
}

export function warmHotCache() {
  startRefresh({ silent: true });
}

async function startRefresh({ silent = false } = {}) {
  let started = false;

  if (!refreshPromise) {
    started = true;
    refreshPromise = fetchHotPayload()
      .then((payload) => {
        cache = { createdAt: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  if (silent && started) {
    refreshPromise.catch((error) => {
      console.warn(`Hot data refresh failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    });
  }

  return refreshPromise;
}

async function fetchHotPayload() {
  const settled = await Promise.all(SOURCES.map(fetchSource));
  const sources = {};
  const flatItems = [];

  for (const result of settled) {
    sources[result.source] = result.ok ? "ok" : "error";
    flatItems.push(...result.items);
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    sourceMeta: SOURCES.map(({ key, label, type }) => ({ key, label, type })),
    sources,
    items: mergeHotItems(flatItems),
    rawItems: flatItems,
  };

  return payload;
}

export async function* getHotResponseStream({ force = false } = {}) {
  if (cache) {
    const stale = force || isCacheStale();
    if (stale) {
      startRefresh({ silent: true });
    }
    yield {
      type: "done",
      data: buildCachedResponse({
        cached: true,
        stale,
        refreshing: stale || Boolean(refreshPromise),
      }),
    };
    return;
  }

  await startRefresh();
  yield { type: "done", data: buildCachedResponse({ cached: false }) };
}

function isCacheStale(now = Date.now()) {
  return !cache || now - cache.createdAt >= CACHE_TTL_MS;
}

function buildCachedResponse({ cached, stale = false, refreshing = false } = {}) {
  return {
    ...cache.payload,
    cached,
    stale,
    refreshing,
    cacheAgeMs: Math.max(0, Date.now() - cache.createdAt),
  };
}

export async function fetchSource(source) {
  if (source.type === "media") {
    return fetchMediaSource(source);
  }

  for (const base of getApiBases()) {
    try {
      const data = await requestJson(`${base.replace(/\/$/, "")}/${source.path}`);
      return {
        source: source.key,
        ok: true,
        items: normalizeSourceItems(data, source),
      };
    } catch {
      // Try the next configured base.
    }
  }

  try {
    return {
      source: source.key,
      ok: true,
      items: await fetchDirectSource(source),
    };
  } catch {
    // Fall through to a source-level error so other platforms can still render.
  }

  return { source: source.key, ok: false, items: [] };
}

async function fetchMediaSource(source) {
  for (const feedUrl of source.feeds) {
    try {
      const xml = await requestFeedText(feedUrl);
      const items = await translateMediaItems(parseRssItems(xml, source).slice(0, 15));
      if (items.length) {
        return { source: source.key, ok: true, items };
      }
    } catch {
      // Try the next feed for this publisher.
    }
  }

  return { source: source.key, ok: false, items: [] };
}

async function requestFeedText(url) {
  try {
    return await requestText(url, {
      accept: "application/rss+xml,application/xml,text/xml,text/html",
    });
  } catch (error) {
    if (process.platform !== "win32") throw error;
    return requestFeedTextWithPowerShell(url);
  }
}

export function getApiBases() {
  const configured = process.env.HOT_API_BASES || process.env.DAILYHOT_BASE || "";
  const bases = configured
    .split(",")
    .map((base) => base.trim())
    .filter(Boolean);
  return bases.length ? bases : DEFAULT_BASES;
}

async function requestJson(url, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        ...headers,
      },
    });

    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return await response.json();
  } catch (error) {
    const text = await requestTextWithSystemProxy(url, headers).catch(() => {
      throw error;
    });
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestText(url, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/json",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        ...headers,
      },
    });

    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return await response.text();
  } catch (error) {
    return requestTextWithSystemProxy(url, headers).catch(() => {
      throw error;
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestTextWithSystemProxy(url, headers = {}) {
  if (process.platform !== "win32") throw new Error("System proxy fallback is only available on Windows");
  if (!isAllowedOutboundUrl(url)) throw new Error("Refusing to request an unknown URL");

  const accept = headers.accept || "text/html,application/json,application/xml";
  const script = [
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8;",
    "$OutputEncoding = [Text.Encoding]::UTF8;",
    "$ProgressPreference='SilentlyContinue';",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;",
    "$headers = @{'User-Agent'='Mozilla/5.0'; 'Accept'=$env:HOT_ACCEPT};",
    "$response = Invoke-WebRequest -UseBasicParsing -Uri $env:HOT_REQUEST_URL -Headers $headers -TimeoutSec 12;",
    "$response.Content",
  ].join(" ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    timeout: REQUEST_TIMEOUT_MS + 5000,
    maxBuffer: 1024 * 1024 * 3,
    windowsHide: true,
    env: { ...process.env, HOT_REQUEST_URL: url, HOT_ACCEPT: accept },
  });

  return stdout;
}

async function requestFeedTextWithPowerShell(url) {
  return requestTextWithSystemProxy(url, {
    accept: "application/rss+xml,application/xml,text/xml,text/html",
  });
}

function isAllowedOutboundUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (parsed.hostname === "translate.googleapis.com") return true;
    if (parsed.hostname === "api-hot.imsyy.top") return true;
    if (["top.baidu.com", "weibo.com", "api.zhihu.com"].includes(parsed.hostname)) return true;
    if (["www.ithome.com", "www.gamersky.com"].includes(parsed.hostname)) return true;
    return SOURCES.some((source) => source.feeds?.includes(url) || source.homeUrl === url);
  } catch {
    return false;
  }
}

async function fetchDirectSource(source) {
  if (source.key === "baidu") return fetchDirectBaidu(source);
  if (source.key === "weibo") return fetchDirectWeibo(source);
  if (source.key === "zhihu") return fetchDirectZhihu(source);
  if (source.key === "gamersky") return fetchDirectGamersky(source);
  return [];
}

async function fetchDirectBaidu(source) {
  const html = await requestText("https://top.baidu.com/board?tab=realtime");
  const match = html.match(/<!--s-data:(.*?)-->/s);
  if (!match) throw new Error("Baidu hot data not found");

  const data = JSON.parse(match[1]);
  const list = data?.data?.cards?.[0]?.content || data?.cards?.[0]?.content || [];

  return list
    .map((item, index) => ({
      source: source.key,
      sourceLabel: source.label,
      title: pickString(item.word, item.query, item.title),
      description: cleanText(pickString(item.desc, item.content)),
      url: item.query ? `https://www.baidu.com/s?wd=${encodeURIComponent(item.query)}` : source.homeUrl,
      rank: toRank(item.index, index + 1),
      hot: pickString(item.hotScore, item.hotTag),
      image: pickString(item.img, item.pic, item.pic_url, item.image),
    }))
    .filter((item) => item.title);
}

async function fetchDirectWeibo(source) {
  const data = await requestJson("https://weibo.com/ajax/side/hotSearch", {
    referer: "https://weibo.com/",
  });
  const list = [
    ...(Array.isArray(data?.data?.hotgovs) ? data.data.hotgovs : []),
    ...(Array.isArray(data?.data?.realtime) ? data.data.realtime : []),
  ];

  return list
    .map((item, index) => {
      const title = pickString(item.word, item.note, item.name, item.desc).replace(/^#|#$/g, "");
      const query = item.word_scheme || item.word || title;
      return {
        source: source.key,
        sourceLabel: source.label,
        title,
        description: cleanText(pickString(item.note, item.desc_extr, item.category)),
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(query)}&t=31&band_rank=1&Refer=top`,
        rank: toRank(item.pos, item.rank, index + 1),
        hot: pickString(item.num, item.raw_hot, item.icon_desc),
        image: pickString(item.pic),
      };
    })
    .filter((item) => item.title);
}

async function fetchDirectZhihu(source) {
  const data = await requestJson("https://api.zhihu.com/topstory/hot-lists/total?limit=50");
  const list = Array.isArray(data?.data) ? data.data : [];

  return list
    .map((item, index) => {
      const target = item.target || {};
      const title = pickString(target.title, item.title);
      const questionId = pickString(target.url).split("/").filter(Boolean).pop();
      return {
        source: source.key,
        sourceLabel: source.label,
        title,
        description: cleanText(pickString(target.excerpt, item.detail_text)),
        url: questionId ? `https://www.zhihu.com/question/${questionId}` : source.homeUrl,
        rank: index + 1,
        hot: pickString(item.detail_text),
        image: pickString(target.image_url, target.thumbnail, item.image_url, item.thumbnail),
      };
    })
    .filter((item) => item.title);
}

async function fetchDirectGamersky(source) {
  const html = await requestText(source.homeUrl);
  const matches = Array.from(html.matchAll(/<li>\s*<div class="tit">[\s\S]*?<\/li>/gi));

  return matches
    .map((match, index) => {
      const block = match[0];
      const linkMatch = block.match(/<a\b[^>]*class="tt"[^>]*href="([^"]+)"[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) return null;

      return {
        source: source.key,
        sourceLabel: source.label,
        title: cleanText(linkMatch[2] || linkMatch[3]),
        description: cleanText(readClassText(block, "txt")),
        url: normalizePublisherUrl(linkMatch[1]) || source.homeUrl,
        rank: index + 1,
        hot: cleanText(readClassText(block, "time")) || "latest",
        image: pickString(readAttr(block, "img", "src")),
      };
    })
    .filter((item) => item?.title)
    .slice(0, 30);
}

export function normalizeSourceItems(raw, source) {
  const list = Array.isArray(raw?.data)
    ? raw.data
    : Array.isArray(raw?.items)
      ? raw.items
      : Array.isArray(raw)
        ? raw
        : [];

  return list
    .map((item, index) => {
      const title = pickString(item.title, item.name, item.keyword, item.word, item.desc);
      if (!title) return null;

      return {
        source: source.key,
        sourceLabel: source.label,
        title,
        description: cleanText(pickString(item.description, item.summary, item.desc, item.content)),
        url: pickString(item.url, item.link, item.mobileUrl, item.pcUrl) || source.homeUrl,
        rank: toRank(item.rank, item.index, item.position, index + 1),
        hot: pickString(item.hot, item.heat, item.views),
        image: pickString(item.pic, item.img, item.image, item.imgs, item.thumbnail, item.avatar),
      };
    })
    .filter(Boolean);
}

function readAttr(xml, tagName, attrName) {
  const escaped = tagName.replace(":", "\\:");
  const match = xml.match(new RegExp(`<${escaped}[^>]*\\s${attrName}="([^"]*)"`, "i"));
  return match?.[1]?.trim() || "";
}

export function parseRssItems(xml, source) {
  const itemBlocks = Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi), (match) => match[0]);
  const entries = itemBlocks.length
    ? itemBlocks
    : Array.from(xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi), (match) => match[0]);

  return entries
    .map((entry, index) => {
      const title = cleanPublisherTitle(repairMojibake(decodeEntities(stripTags(readTag(entry, "title")))));
      const description = cleanText(decodeEntities(stripTags(readTag(entry, "description") || readTag(entry, "summary") || readTag(entry, "content:encoded"))));
      const rawDescription = readTag(entry, "description") || readTag(entry, "summary") || readTag(entry, "content:encoded");
      const link = pickString(readTag(entry, "link"), readAtomLink(entry), source.homeUrl);

      if (!title) return null;
      const image = pickString(
        readAttr(entry, "media:content", "url"),
        readAttr(entry, "media:thumbnail", "url"),
        readAttr(entry, "enclosure", "url"),
        extractFirstImageUrl(rawDescription),
      );
      return {
        source: source.key,
        sourceLabel: source.label,
        title,
        description,
        url: normalizePublisherUrl(link),
        rank: index + 1,
        hot: "latest",
        image,
      };
    })
    .filter(Boolean);
}

function readClassText(html, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<[^>]+class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"));
  return match?.[1] || "";
}

function extractFirstImageUrl(value) {
  const decoded = decodeEntities(value);
  const match = decoded.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  return match?.[1]?.trim() || "";
}

function cleanPublisherTitle(title) {
  return String(title || "")
    .replace(/\s+-\s+(Reuters|BBC News|Financial Times|The Economist)$/i, "")
    .trim();
}

const translationCache = new Map();

async function translateMediaItems(items) {
  const concurrency = 2;
  const results = new Array(items.length);
  const queue = items.map((item, i) => ({ item, i }));

  async function worker() {
    while (queue.length) {
      const entry = queue.shift();
      if (!entry) break;
      const { item, i } = entry;
      const [translatedTitle, translatedDescription] = await Promise.all([
        translateToChinese(item.title),
        item.description ? translateToChinese(item.description) : Promise.resolve(""),
      ]);
      results[i] = {
        ...item,
        originalTitle: item.title,
        originalDescription: item.description,
        title: translatedTitle || item.title,
        description: translatedDescription || item.description,
      };
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function translateToChinese(text) {
  const value = cleanText(text);
  if (!value || containsHan(value)) return value;
  if (translationCache.has(value)) return translationCache.get(value);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(value)}`;
      const data = await requestJson(url);
      const translated = Array.isArray(data?.[0])
        ? data[0].map((part) => part?.[0] || "").join("")
        : "";
      const result = cleanText(translated);
      if (result) {
        translationCache.set(value, result);
        return result;
      }
    } catch {
      // Retry once on failure.
    }
  }

  return value;
}

function containsHan(value) {
  return /\p{Script=Han}/u.test(value);
}

function readTag(xml, tagName) {
  const escapedName = tagName.replace(":", "\\:");
  const match = xml.match(new RegExp(`<${escapedName}[^>]*>([\\s\\S]*?)<\\/${escapedName}>`, "i"));
  return match?.[1]?.trim() || "";
}

function readAtomLink(xml) {
  const match = xml.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  return match?.[1]?.trim() || "";
}

function normalizePublisherUrl(url) {
  const decoded = decodeEntities(stripTags(url));
  try {
    const parsed = new URL(decoded);
    const target = parsed.searchParams.get("url") || parsed.searchParams.get("u");
    if (target) return target;
    return parsed.href;
  } catch {
    return decoded;
  }
}

function cleanText(value) {
  return repairMojibake(decodeEntities(stripTags(value)))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function stripTags(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function repairMojibake(value) {
  return String(value || "")
    .replace(/â/g, "’")
    .replace(/â/g, "‘")
    .replace(/â/g, "“")
    .replace(/â/g, "”")
    .replace(/â/g, "–")
    .replace(/â/g, "—")
    .replace(/â¦/g, "…")
    .replace(/Â/g, "");
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function toRank(...values) {
  for (const value of values) {
    const rank = Number.parseInt(String(value), 10);
    if (Number.isFinite(rank) && rank > 0) return rank;
  }
  return 999;
}

export function mergeHotItems(items) {
  if (items.length === 0) return [];

  const indexed = items.map((item) => ({
    item,
    norm: normalizeTitle(item.title),
    profile: buildTitleProfile(item.title),
  }));

  const groups = [];
  for (const entry of indexed) {
    const matchedGroups = [];
    for (let g = 0; g < groups.length; g++) {
      if (isRelatedToGroup(entry.profile, groups[g])) {
        matchedGroups.push(g);
      }
    }

    if (!matchedGroups.length) {
      groups.push({
        members: [entry],
        sources: [entry.item],
        aliases: [entry.item.title],
        descriptions: [entry.item.description],
        title: entry.item.title,
        normalizedTitle: entry.norm,
        anchorProfile: entry.profile,
        profiles: [entry.profile],
      });
    } else {
      const g = groups[matchedGroups[0]];
      for (let i = matchedGroups.length - 1; i >= 1; i--) {
        const merged = groups.splice(matchedGroups[i], 1)[0];
        g.members.push(...merged.members);
        g.sources.push(...merged.sources);
        g.aliases.push(...merged.aliases);
        g.descriptions.push(...merged.descriptions);
        g.profiles.push(...merged.profiles);
      }
      g.members.push(entry);
      g.sources.push(entry.item);
      g.aliases.push(entry.item.title);
      g.descriptions.push(entry.item.description);
      g.profiles.push(entry.profile);
      g.normalizedTitle = chooseRepresentativeNormalized(g.normalizedTitle, entry.norm);
      g.title = chooseRepresentativeTitle(g.aliases);
    }
  }

  return groups
    .map((group) => ({
      id: stableId(group.normalizedTitle || group.title),
      title: group.title,
      description: chooseDescription(group.descriptions),
      image: group.sources.find((s) => s.image)?.image || "",
      sources: sortSources(group.sources),
    }))
    .sort((a, b) => {
      if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
      return averageRank(a.sources) - averageRank(b.sources);
    });
}

function isRelatedToGroup(profile, group) {
  return group.profiles.some((memberProfile) => isSameStory(profile, memberProfile));
}

function chooseDescription(descriptions) {
  return descriptions
    .map(cleanText)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || "";
}

function dedupeSources(sources) {
  const bestBySource = new Map();
  for (const source of sources) {
    const previous = bestBySource.get(source.source);
    if (!previous || source.rank < previous.rank) bestBySource.set(source.source, source);
  }
  return Array.from(bestBySource.values());
}

function sortSources(sources) {
  const order = new Map(SOURCES.map((source, index) => [source.key, index]));
  return [...sources].sort((a, b) => (order.get(a.source) ?? 99) - (order.get(b.source) ?? 99));
}

function averageRank(sources) {
  return sources.reduce((sum, source) => sum + source.rank, 0) / Math.max(sources.length, 1);
}

export function normalizeTitle(title) {
  return String(title)
    .toLowerCase()
    .replace(/#|【|】|\[|\]|\(|\)|（|）|“|”|"|'|！|!|？|\?|，|,|。|\.|、|:|：|;|；|\s+/g, "")
    .replace(/官方通报|官方回应|热搜|热榜|置顶|爆|沸|新|荐|广告|视频|图文|exclusive|breaking|live|update|最新消息|刚刚|突发|快讯|详情|全文|解读|分析|评论|专题|报道|路透中文网|路透社|路透|如何看待|如何评价|封面故事时事通讯|知情人士/g, "")
    .trim();
}

function chooseRepresentativeNormalized(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;
  return candidate.length > current.length ? candidate : current;
}

function chooseRepresentativeTitle(titles) {
  return [...titles].sort((a, b) => {
    const cleanDiff = normalizeTitle(b).length - normalizeTitle(a).length;
    return cleanDiff || a.length - b.length;
  })[0];
}

export function isSimilarTitle(a, b) {
  return isSameStory(buildTitleProfile(a), buildTitleProfile(b));
}

function buildTitleProfile(title) {
  const norm = canonicalizeEventTerms(normalizeTitle(title));
  const grams = ngrams(norm);
  const meaningfulGrams = new Set([...grams].filter(isMeaningfulGram));
  return {
    norm,
    grams,
    meaningfulGrams,
    eventTerms: extractEventTerms(norm),
    length: [...norm].length,
  };
}

function isSameStory(left, right) {
  if (!left.norm || !right.norm) return false;
  if (left.norm === right.norm) return true;
  if (isSafeContainment(left, right)) return true;

  const shared = overlapSize(left.grams, right.grams);
  const meaningfulShared = overlapSize(left.meaningfulGrams, right.meaningfulGrams);
  if (meaningfulShared < 2) return false;

  const minGramCount = Math.min(left.grams.size, right.grams.size);
  const coverage = minGramCount ? shared / minGramCount : 0;
  const similarity = jaccard(left.grams, right.grams);
  const lengthRatio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
  const commonRun = longestCommonSubstringLength(left.norm, right.norm);

  if (coverage >= 0.72 && meaningfulShared >= 3 && (similarity >= 0.3 || commonRun >= 3)) {
    return true;
  }

  if (coverage >= 0.5 && similarity >= 0.18 && meaningfulShared >= 3 && commonRun >= 3 && lengthRatio >= 0.5) {
    return true;
  }

  if (similarity >= 0.38 && coverage >= 0.6 && meaningfulShared >= 4 && lengthRatio >= 0.35) {
    return true;
  }

  if (commonRun >= 4 && meaningfulShared >= 4 && coverage >= 0.4 && similarity >= 0.2) {
    return true;
  }

  if (hasSharedPersonEventContext(left, right, commonRun, meaningfulShared)) {
    return true;
  }

  if (commonRun >= 4 && meaningfulShared >= 5 && coverage >= 0.35 && similarity >= 0.18) {
    return true;
  }

  return false;
}

function canonicalizeEventTerms(text) {
  return text
    .replace(/访问中国|访中国|赴中国|前往中国|去中国|到访中国|抵达中国|赴华|来华/g, "访华")
    .replace(/访问美国|访美国|赴美国|赴美|来美/g, "访美");
}

function extractEventTerms(text) {
  const terms = new Set();
  const patterns = [
    /访华|访美/g,
    /电影节|发布会|峰会|会议|会谈|会晤|会见|访问|行程|名单|关税|进口税/g,
    /启程|抵达|到达|离开|出席|参加|开幕式|红毯|主席|高管|表态|回应|宣布/g,
    /发言|讲话|致辞|声明|批评|支持|反对|签署|达成|取消|推迟|任命|辞职|逝世|去世/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      terms.add(match[0]);
    }
  }

  return terms;
}

function hasSharedPersonEventContext(left, right, commonRun, meaningfulShared) {
  if (commonRun < 2 || meaningfulShared < 2) return false;
  if (!hasSharedEntity(left, right, commonRun)) return false;

  if (overlapSize(left.eventTerms, right.eventTerms)) return true;

  const bothHaveEventContext = left.eventTerms.size > 0 && right.eventTerms.size > 0;
  return bothHaveEventContext && commonRun >= 3;
}

function hasSharedEntity(left, right, commonRun) {
  if (commonRun >= 3) return true;

  const leftPrefix = left.norm.slice(0, 4);
  const rightPrefix = right.norm.slice(0, 4);
  const leftStartsWithShared = [...right.meaningfulGrams].some((gram) => leftPrefix.includes(gram));
  const rightStartsWithShared = [...left.meaningfulGrams].some((gram) => rightPrefix.includes(gram));
  return leftStartsWithShared && rightStartsWithShared;
}

function isSafeContainment(left, right) {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length < 4) return false;
  if (!longer.norm.includes(shorter.norm)) return false;

  const lengthCoverage = shorter.length / Math.max(longer.length, 1);
  if (lengthCoverage >= 0.52) return true;

  const meaningfulCount = shorter.meaningfulGrams.size;
  const sharedMeaningful = overlapSize(shorter.meaningfulGrams, longer.meaningfulGrams);
  return shorter.length >= 5 && lengthCoverage >= 0.35 && sharedMeaningful >= Math.min(4, meaningfulCount);
}

function overlapSize(left, right) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function isMeaningfulGram(gram) {
  if (!gram || /^\d+$/.test(gram)) return false;
  const chars = [...gram];
  const useful = chars.filter((char) => !STOP_CHARS.has(char) && !/\d/.test(char));
  return useful.length >= Math.ceil(chars.length * 0.5);
}

function longestCommonSubstringLength(left, right) {
  const a = [...left];
  const b = [...right];
  let best = 0;
  const previous = Array(b.length + 1).fill(0);
  const current = Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : 0;
      if (current[j] > best) best = current[j];
    }
    previous.splice(0, previous.length, ...current);
    current.fill(0);
  }

  return best;
}

function ngrams(text) {
  if (text.length <= 2) return new Set([text]);
  const grams = new Set();
  for (let i = 0; i < text.length - 1; i++) {
    grams.add(text.slice(i, i + 2));
  }
  return grams;
}

const STOP_CHARS = new Set("的一是在和了有为与对就都而及或被把将中上下降后前如何为何什么最新官方回应通报称真的很");

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function stableId(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `hot-${(hash >>> 0).toString(36)}`;
}
