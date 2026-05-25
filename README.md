# V50 Copywriter

Language: [English](README.md) | [简体中文](README.zh-CN.md)

Generate a short V50 post.

Type a keyword and click Generate. If you're not happy with it, click Again until one lands, then copy it to your clipboard.

This is a fan-made meme tool, not an official KFC product, and it does not use official brand assets.

## The Recipe

- Optional keyword.
- Generate one piece of copy.
- Click Again for a different angle.
- Copy the current result to your clipboard.
- Revisit your latest 5 results on the page.

## For Curious Readers

- It doesn't search the internet. The project ships with a built-in set of example copy, which is stored in a SQL database and indexed in a vector database.
- When you enter a keyword, BGE-M3 turns it into an embedding, then looks up the examples closest in meaning from the vector index.
- Picking references isn't pure random sampling — it adds a bit of diversity so you don't end up with six versions of the same joke.
- Your keyword, the selected references, and your most recent previous results go to Kimi K2.5, which writes a new piece of copy.
- When you click Again, the first few tries stay close to the same references to keep the theme on track. After several clicks, it widens the search so the next result is more random.
- When you click Copy, the result is recorded on the server and may be added to the corpus in the future.
- The recent history shown on the page is stored only locally in your browser.

## Corpus Sources

- [Crazy Thursday](https://www.crazy-thursday.com/)
- [vikiboss/v50](https://github.com/vikiboss/v50)
- [Douban](https://www.douban.com/group/topic/253838719/)
- [VME](https://vme.im/jokes?type=text)
- Zhihu Zhuanlan: [632097424](https://zhuanlan.zhihu.com/p/632097424), [715926417](https://zhuanlan.zhihu.com/p/715926417), [440327119](https://zhuanlan.zhihu.com/p/440327119)

## Contribute to the Corpus

The example corpus lives in [`references/v50_corpus.json`](references/v50_corpus.json). Pull requests are warmly welcome — everyone is invited to add new V50 copy, and the funnier, the better.

Each entry looks like this:

```json
{
  "text": "your V50 copy goes here",
  "source": "your name or where it came from",
  "source_url": "https://link-to-the-original/or_empty"
}
```

Add your items to the `items` array — no need to set an `id`, the import step generates a stable one from the text. Then open a pull request. Once it's merged, the maintainer re-imports and re-indexes the corpus (`npm run import:corpus` and `npm run index:corpus`) so your lines can start showing up in generations.
