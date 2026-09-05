---
'@kernhq/module-quire': minor
---

`@` in a comment names somebody, and they are told. The comment composer and its reply box were
given no mention source, so `RichTextEditor` never installed the mention node and typing `@ada`
left the characters `@ada` in a sentence — while the server has always read `mention` nodes out of
a body and raised a `quire.mention` notification for everybody named. A comment that is only a
mention can now be posted, and the name stays in the line the margin and the notification show.
