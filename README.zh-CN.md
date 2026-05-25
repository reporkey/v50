# V我50 文案机

语言：[English](README.md) | [简体中文](README.zh-CN.md)

生成一条 V50 小作文。

输入一个关键词，点击生成；不满意就点再来一条，直到出现一条满意的，可以复制到粘贴板。

这是一个同人梗工具，不是 KFC 官方产品，也不使用官方品牌素材。

## 食用指南

- 可选关键词。
- 生成一条文案。
- 点再来一条，换一个角度。
- 把当前结果复制到剪贴板。
- 在页面里回看最近 5 条生成结果。

## 如果你想知道它怎么写的

- 它不会联网搜索。项目里内置了一批示例语料，这些内容会存进 SQL 数据库，并在向量数据库里建立索引。
- 当你输入关键词时，BGE-M3 把关键词变成向量，再去向量索引里找语义接近的示例。
- 挑参考时不是纯随机抽样，还会加一点多样性，避免拿到的全是同一个笑话的六种写法。
- 你的关键词、选出来的参考，以及最近几条上一版结果会给 Kimi K2.5，写出一条新文案。
- 你点再来一条时，前几次会尽量贴着同一组参考，保持主题不跑偏。多点几次后，它会扩大搜索范围，让下一条有更多随机性。
- 当你点击复制时，这条结果会被服务器记录，未来可能加入语料库。
- 页面上能看到的最近历史则只保存在你的浏览器本地。

## 语料来源

- [Crazy Thursday](https://www.crazy-thursday.com/)
- [vikiboss/v50](https://github.com/vikiboss/v50)
- [豆瓣](https://www.douban.com/group/topic/253838719/)
- [VME](https://vme.im/jokes?type=text)
- 知乎专栏：[632097424](https://zhuanlan.zhihu.com/p/632097424)、[715926417](https://zhuanlan.zhihu.com/p/715926417)、[440327119](https://zhuanlan.zhihu.com/p/440327119)

## 贡献语料

示例语料都放在 [`references/v50_corpus.json`](references/v50_corpus.json)，非常欢迎大家通过 Pull Request 来贡献——人人都可以添加新的 V50 文案，越好笑越好。

每一条长这样：

```json
{
  "text": "在这里写你的 V50 文案",
  "source": "你的名字或出处",
  "source_url": "https://原文链接/可为空"
}
```

在 `items` 数组里加上你的条目（不用填 `id`，导入时会根据文案自动生成），然后提一个 Pull Request。合并之后，维护者会重新导入并建立索引（`npm run import:corpus` 和 `npm run index:corpus`），你的文案就有机会出现在生成结果里了。
