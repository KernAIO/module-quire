---
'@kernhq/module-quire': patch
---

Seed the demo spaces with lowercase keys.

`Space.key` is `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$` and `SpaceService.create` does not check it —
only the router's input contract does — so the seeder's `HB`, `ENG` and `PRD` were written happily
and then made `quire.spaces.list` answer **500 Output validation failed** for the whole workspace.
Quire was completely unusable in a seeded workspace and the screen said "No spaces yet". Found on
Kern Cloud; every row-counting assertion passed throughout. The test now reads the spaces back
through `spaces.list` and parses each against the contract.
