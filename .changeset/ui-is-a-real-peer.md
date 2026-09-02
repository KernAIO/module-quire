---
'@kernhq/module-quire': patch
---

Declare `@kernhq/ui` as a required peer: the server's page renderer imports `@kernhq/ui/editor/page-doc` and `@kernhq/ui/editor/mermaid`, so a host that does not install `@kernhq/ui` itself — `core` — failed at import with "Cannot find package '@kernhq/ui'" the moment it took 0.16.0.
