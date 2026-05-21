# V50 Copywriter

Language: [English](README.md) | [简体中文](README.zh-CN.md)

Generate a fresh V50 post for your group chat.

Type an optional keyword, click Generate, and keep hitting Again until one lands. When it feels right, copy it and send. The page keeps your latest 5 results so you can compare a few versions before choosing.

This is a fan-made meme tool, not an official KFC product, and it does not use official brand assets.

## What You Can Do

- Add a keyword to steer the setup.
- Generate one short V50 copy at a time.
- Click Again for a different angle.
- Copy the current result to your clipboard.
- Revisit the latest 5 generated results on the page.

## For Curious Readers

The app does not search the internet live. It uses a built-in V50 example corpus that is stored in a SQL database and indexed in a vector database.

When you enter a keyword, the app turns it into an embedding with BGE-M3, then searches the vector index for examples that are close in meaning. It also applies a small diversity step, so the references are not just six versions of the same joke. The selection is similarity-based, not purely random.

The final copy is written by Kimi K2.5. The model receives your keyword, the selected references, and recent previous outputs, then writes one new result.

When you click Again, the app first stays close to the same references so the theme remains consistent. After more retries, it widens the search to make the next result less predictable.

When you click Copy, that result is recorded as an accepted output. The visible recent history is stored locally in your browser.

## Corpus Sources

- [Crazy Thursday](https://www.crazy-thursday.com/)
- [vikiboss/v50](https://github.com/vikiboss/v50)
- [Douban](https://www.douban.com/group/topic/253838719/)
- [VME](https://vme.im/jokes?type=text)
- Zhihu Zhuanlan: [632097424](https://zhuanlan.zhihu.com/p/632097424), [715926417](https://zhuanlan.zhihu.com/p/715926417), [440327119](https://zhuanlan.zhihu.com/p/440327119)
