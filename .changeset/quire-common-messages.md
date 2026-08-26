---
'@kernhq/module-quire': patch
---

Stop using `t('common.*')` in this module's screens.

`@kernhq/ui` declares `sideEffects: ["**/*.css"]`, so a bundler drops
`common-messages.js` — whose only job is a top-level `registerMessages` call — out of every
production build. `t('common.cancel')` therefore renders the literal key in a built app and the
right word in dev, which is why it survived: the confirmation dialog that deletes a view shipped
with buttons reading `common.cancel` and `common.delete`.

Quire now carries its own eight shared words. Collapse them back into `common.*` once the framework
marks that module as having side effects.
