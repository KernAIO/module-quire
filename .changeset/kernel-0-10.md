---
'@kernhq/module-quire': patch
---

Peer on `@kernhq/kernel` `^0.10.0`. A caret on 0.x does not cross a minor, so the previous range
stopped reaching the framework the day 0.10.0 was published — a host installing this module from
the registry could not resolve a kernel it declares.
