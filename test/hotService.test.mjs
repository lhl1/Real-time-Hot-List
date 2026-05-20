import test from "node:test";
import assert from "node:assert/strict";
import { isSimilarTitle, mergeHotItems, normalizeSourceItems, normalizeTitle, parseRssItems } from "../src/hotService.mjs";

function hot(source, title, rank = 1) {
  return {
    source,
    sourceLabel: source,
    title,
    url: `https://${source}.example/${rank}`,
    rank,
    hot: "0",
  };
}

function findGroup(merged, keyword) {
  return merged.find((group) => group.sources.some((source) => source.title.includes(keyword)));
}

function sourceTitles(group) {
  return group.sources.map((source) => source.title);
}

test("normalizes noisy hot-search titles", () => {
  assert.equal(normalizeTitle("# 官方通报某地事件！#"), "某地事件");
});

test("detects same-story titles without merging broad topic neighbors", () => {
  assert.equal(isSimilarTitle("某品牌发布新手机", "某品牌新手机正式发布"), true);
  assert.equal(isSimilarTitle("特朗普启程访华", "特朗普访问中国"), true);
  assert.equal(isSimilarTitle("特朗普启程访华", "欢迎特朗普访问中国"), true);
  assert.equal(isSimilarTitle("特朗普启程访华", "特朗普回应访华团高管名单"), true);
  assert.equal(isSimilarTitle("特朗普启程访华", "特朗普访华对中美关系有何影响"), true);
  assert.equal(isSimilarTitle("特朗普访华", "特朗普前往中国期间油价下跌"), true);
  assert.equal(isSimilarTitle("特朗普访华", "特朗普会见中方领导人"), true);
  assert.equal(isSimilarTitle("特朗普访华", "特朗普回应记者提问"), true);
  assert.equal(isSimilarTitle("特朗普会见中方领导人", "特朗普签署合作声明"), true);
  assert.equal(isSimilarTitle("巩俐宣布担任电影节主席", "巩俐电影节红毯造型"), true);
  assert.equal(isSimilarTitle("巩俐宣布担任电影节主席", "巩俐出席电影节开幕式"), true);
  assert.equal(isSimilarTitle("印度提高黄金进口关税", "印度黄金进口税上调影响几何"), true);
  assert.equal(isSimilarTitle("某品牌发布新手机", "某品牌手机发布会亮点"), true);
  assert.equal(isSimilarTitle("A股收盘沪指上涨", "A股第10只千元股诞生"), false);
  assert.equal(isSimilarTitle("巩俐宣布担任电影节主席", "巩俐巴黎出席品牌活动"), false);
  assert.equal(isSimilarTitle("特朗普访华", "特朗普社交媒体账号粉丝上涨"), false);
});

test("merges only clearly equivalent entries while preserving source links", () => {
  const merged = mergeHotItems([
    hot("baidu", "某品牌发布新手机", 1),
    hot("weibo", "某品牌新手机正式发布", 2),
    hot("zhihu", "全国多地迎来降温", 1),
  ]);

  const phone = findGroup(merged, "某品牌");
  assert.ok(phone, "phone launch group must exist");
  assert.deepEqual(phone.sources.map((source) => source.source), ["baidu", "weibo"]);
  assert.equal(merged.length, 2);
});

test("keeps same entity but different events in separate groups", () => {
  const merged = mergeHotItems([
    hot("baidu", "特朗普启程访华", 1),
    hot("weibo", "特朗普访问中国", 2),
    hot("bbc", "欢迎特朗普访问中国", 3),
    hot("economist", "特朗普访华对中美关系有何影响", 5),
    hot("reuters", "特朗普前往中国期间油价下跌", 3),
    hot("zhihu", "特朗普回应访华团高管名单", 4),
    hot("ft", "特朗普会见中方领导人", 6),
  ]);

  const visit = findGroup(merged, "启程访华");
  assert.ok(visit, "visit group must exist");
  assert.deepEqual(sourceTitles(visit), ["特朗普启程访华", "特朗普访问中国", "特朗普回应访华团高管名单", "特朗普访华对中美关系有何影响", "特朗普前往中国期间油价下跌", "特朗普会见中方领导人", "欢迎特朗普访问中国"]);
});

test("bridges related person-event groups without a merge size limit", () => {
  const merged = mergeHotItems([
    hot("baidu", "特朗普访华", 1),
    hot("weibo", "特朗普会见中方领导人", 2),
    hot("zhihu", "特朗普签署合作声明", 3),
    hot("bbc", "特朗普参加欢迎晚宴", 4),
    hot("reuters", "特朗普社交媒体账号粉丝上涨", 5),
  ]);

  const visit = findGroup(merged, "访华");
  const social = findGroup(merged, "社交媒体");

  assert.ok(visit, "visit group must exist");
  assert.ok(social, "social-media group must exist");
  assert.deepEqual(sourceTitles(visit), ["特朗普访华", "特朗普会见中方领导人", "特朗普签署合作声明", "特朗普参加欢迎晚宴"]);
  assert.equal(social.sources.length, 1);
});

test("does not let short generic topics absorb unrelated entries", () => {
  const merged = mergeHotItems([
    hot("weibo", "A股", 1),
    hot("baidu", "A股收盘沪指上涨", 2),
    hot("zhihu", "A股第10只千元股诞生", 3),
    hot("ft", "印度提高黄金进口关税", 4),
    hot("reuters", "印度黄金白银期货上涨", 5),
  ]);

  assert.equal(findGroup(merged, "A股").sources.length, 1);
  assert.equal(findGroup(merged, "收盘").sources.length, 1);
  assert.equal(findGroup(merged, "千元股").sources.length, 1);
  assert.equal(findGroup(merged, "进口关税").sources.length, 1);
  assert.equal(findGroup(merged, "白银期货").sources.length, 1);
});

test("merges exact duplicates and never loses input items", () => {
  const input = [
    hot("baidu", "豆包收费 大模型将告别免费时代", 1),
    hot("weibo", "豆包收费 大模型将告别免费时代", 2),
    hot("baidu", "聋哑老人卖菜籽被商贩少称近100斤", 3),
    hot("weibo", "聋哑老人卖菜籽被商贩少称近100斤", 4),
    hot("zhihu", "男子直视太阳10分钟视力下降至0.4", 5),
  ];

  const merged = mergeHotItems(input);
  const totalSourcesOut = merged.reduce((sum, group) => sum + group.sources.length, 0);

  assert.equal(findGroup(merged, "豆包收费").sources.length, 2);
  assert.equal(findGroup(merged, "聋哑老人").sources.length, 2);
  assert.equal(findGroup(merged, "直视太阳").sources.length, 1);
  assert.equal(totalSourcesOut, input.length, "every input item must appear in output");
});

test("normalizes DailyHot-style response fields", () => {
  const items = normalizeSourceItems(
    {
      data: [
        {
          title: "热点标题",
          url: "https://example.com/hot",
          hot: "123万",
          rank: 3,
        },
      ],
    },
    { key: "baidu", label: "百度", homeUrl: "https://top.baidu.com" },
  );

  assert.equal(items[0].title, "热点标题");
  assert.equal(items[0].source, "baidu");
  assert.equal(items[0].rank, 3);
});

test("parses RSS publisher items with descriptions", () => {
  const items = parseRssItems(
    `<?xml version="1.0"?><rss><channel><item><title>Markets rally</title><link>https://www.reuters.com/markets/story</link><description><![CDATA[Global markets rose after central banks signalled caution.]]></description></item></channel></rss>`,
    { key: "reuters", label: "Reuters", homeUrl: "https://www.reuters.com/" },
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].source, "reuters");
  assert.equal(items[0].title, "Markets rally");
  assert.equal(items[0].description, "Global markets rose after central banks signalled caution.");
});

test("cleans publisher suffixes from media RSS titles", () => {
  const items = parseRssItems(
    `<?xml version="1.0"?><rss><channel><item><title>Global tensions rise - Reuters</title><link>https://news.google.com/rss/articles/example</link></item></channel></rss>`,
    { key: "reuters", label: "Reuters", homeUrl: "https://www.reuters.com/world/" },
  );

  assert.equal(items[0].title, "Global tensions rise");
});
