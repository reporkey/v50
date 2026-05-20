# V50 Corpus Findings

Generated from `references/v50_reference_corpus.json`, a broad reference corpus that intentionally keeps both explicit Crazy Thursday/V50 texts and adjacent abstract, emo, meme, and social copy.

## Corpus Shape

- Total broad corpus: 5015 items, 309391 Chinese characters.
- Explicit Crazy Thursday/KFC/V50/request signal: 3910 items.
- Adjacent non-explicit abstract or social copy: 1105 items.
- Main sources: crazy-thursday.com, user-provided Zhihu samples, Douban, vikiboss/v50, and vme.im/jokes.
- Length distribution is mostly short or medium: many items are under 80 characters, but the strongest classic V50 pieces often sit in the 160+ character range.

## What The References Actually Do

- They do not merely mention KFC. The good ones create a social situation where asking for food money feels like the natural final absurdity.
- The core move is tonal fracture: a sincere confession, workplace complaint, fake notice, breakup story, pseudo-scientific claim, or abstract self-description suddenly collapses into a food-money request.
- The best long pieces delay the V50 reveal. The reader should briefly believe they are reading a real complaint, gossip, announcement, love letter, application, confession, or life advice.
- The best short pieces are not shorter versions of long essays. They rely on a compact equation, pun, screenshot-like message, fake system notice, or one-line social truth.
- Non-explicit abstract copy matters because it supplies voice: self-mockery, emo exaggeration, absurd metaphors, internet rhythm, and deliberately rough group-chat texture.
- The broad corpus also contains noise: webpage titles, collection descriptions, menu/price fragments, marketing language, comments, and generic social copy. These are preserved for auditability, but they are not all equal creative targets.

## Emergent Patterns

- **Late-Reveal Story**: starts as gossip, grievance, romance, work disaster, family drama, or revenge setup; the ending asks for food money or says eating first unlocks the next part.
- **Fake System Or Institution**: notice, rule, fee, fine, registration, HR hiring, school parent group, group management, financial product, medical report, or legal disclaimer.
- **Group-Chat Meta**: complains that nobody chats, nobody sends V50 copy, nobody invites the speaker, or the group owes the speaker money by some invented logic.
- **Emo Self-Exposure**: loneliness, failed love, aging, social anxiety, being ignored, or not fitting in; the emotional pressure is intentionally disproportionate to the tiny ask.
- **Abstract Social Copy**: chaotic self-description, meme logic, mock inspirational copy, weird metaphors, and punchline-ready emotional debris.
- **Pseudo-Expert Logic**: cold knowledge, research, medicine, tradition, law, finance, tariffs, cosmic signals, or ritual explanations that justify a very small transfer.
- **Roleplay And Identity Theft**: emperors, monsters, gods, employees, students, scammers, bosses, exes, parents, customer service, or historical/fictional figures all speak in first person.
- **Code-Switching And Glyph Play**: English, Japanese particles, Korean text, weird spacing, repeated letters, fake CDK strings, emoji, and UI-like message formats.

## What Makes A Good V50 Copy

1. It has a recognizable social container: group chat, workplace, school, relationship, fake notice, online confession, public post, or weird ad.
2. It uses commitment before the joke: the narrator sounds like they believe the bit, even when the logic is ridiculous.
3. The ending bends the setup instead of replacing it. The ask should grow out of the previous detail, not be stapled on.
4. It has a shareable voice: rough, oral, slightly overlong or weirdly concise, but not polished like brand copy.
5. It lets the money/food request appear in varied forms: direct transfer, being invited to eat, deposit, fine, fee, debt, sponsorship, reward, emotional repair, or operational cost.
6. It avoids obvious AI habits: explaining the joke, neatly summarizing the structure, using balanced paragraphs, or ending with a generic slogan.
7. It recombines patterns. A strong new item can mix fake HR + group-chat meta, emo + finance math, pseudo-medicine + food therapy, or abstract copy + sudden request.
8. It may borrow rhythm from non-explicit abstract copy, but the final generated item still needs a V50-style landing: request, debt, food invitation, fee, subsidy, sponsorship, or similar.

## Failure Modes

- The text reads like a KFC advertisement or coupon post.
- The ending says "today is Crazy Thursday" but has no relationship to the preceding setup.
- The request direction is wrong: the narrator pays for others when the task is to generate V50/request copy.
- The wording is too clean, explanatory, or assistant-like.
- It copies a known reference too closely instead of mutating the mechanism.
- It uses explicit payment accounts, QR codes, or real transaction instructions.
- It is only crude without structure; roughness is useful only when it supports rhythm or persona.
- It imitates scraped webpage residue: titles, SEO descriptions, recommendation blurbs, collection intros, or menu/price dumps.
- It becomes realistic fraud: actionable job deposits, card fees, links, phone numbers, bank cards, QR codes, or concrete payment workflows.
- It uses heavy sexual content, sexual coercion, minors in sexual contexts, domestic abuse as shock bait, self-harm threats, or realistic public-shaming claims.

## Test Rubric

Score each generated copy out of 100 after reading it as a potential group-chat forward:

- **Social Container And Persona, 15**: Does it have a concrete or implied speaking position, persona, group-chat context, system format, abstract self-description, or instantly shareable social voice? A full story is not required.
- **Setup Commitment, 15**: In long copy, does it seriously build the premise? In short or abstract copy, does it have clear weird logic, emotional pressure, rhythm, or concept linkage instead of direct template shouting?
- **V50 Landing, 20**: Does the final ask/food-money logic land clearly and connect to the setup?
- **Shareable Internet Voice, 15**: Does it have the rough, funny, meme-like rhythm seen in the corpus rather than brand or AI polish?
- **Fresh Recombination, 15**: Does it avoid obvious old templates and combine ideas in a new enough way?
- **Keyword Integration, 10**: If a keyword is provided, does it affect the premise or punchline rather than appear as a label?
- **Basic Usability, 10**: Is it readable, self-contained, not an explanation, and free of real payment details? Oral roughness, dislocation, and mild abstraction are allowed if they are not pure gibberish.

Thresholds:

- 85+: strong; keep.
- 75-84: usable; keep unless many similar outputs exist.
- 60-74: rewrite once with the same premise but stronger landing.
- Below 60: reject and generate a new premise.

Automatic rejection:

- No discernible ask, food-money, debt, fee, sponsorship, or "please invite me to eat" landing.
- Payment direction is backwards.
- Pure brand ad/coupon copy.
- Real payment account, QR code, or operational payment instructions.
- Close paraphrase of a reference item.
- No V50-style anchor at all: no 50-ish amount, no Thursday/KFC/fried-chicken cue, no group debt/fee/subsidy/sponsorship/request-to-treat hook.
- Brand/menu/price/coupon language dominates the text.
- Realistic scam flow or actionable fraud language.
- Heavy sexual, coercive, domestic-abuse, self-harm-threat, or realistic public-shaming content.
