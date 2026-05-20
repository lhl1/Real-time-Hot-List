# 实时热榜聚合

聚合百度热搜、微博热搜、知乎热榜，以及 Economist、Reuters、Financial Times。系统会按标题相似度合并跨平台相近词条，国际媒体内容会自动翻译成中文。页面每 5 分钟自动刷新，也可以手动刷新。

## 运行

```bash
npm start
```

打开 `http://127.0.0.1:8080/`。

## 接口

```http
GET /api/hot
```

返回字段：

- `updatedAt`：本次数据更新时间
- `sources`：各平台状态，`ok` 或 `error`
- `items`：合并后的热榜词条
- `items[].sources`：词条对应的平台来源和跳转链接

强制刷新缓存：

```http
GET /api/hot?refresh=1
```

## 数据策略

优先请求 DailyHotApi 公共实例；如果公共实例不可达，会自动降级到平台公开入口或 RSS。Windows 下 Node 请求失败时，会自动改用系统网络通道请求，从而继承系统代理设置。服务端缓存 5 分钟，避免频繁请求外部平台。
