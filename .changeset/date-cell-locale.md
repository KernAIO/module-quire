---
'@kernhq/module-quire': patch
---

A date column reads in the interface language, not the browser's.

A native `<input type="date">` draws its value in the **browser's** locale and nothing can restyle
that. The cell was left permanently in edit mode, so a Persian table showed `08/21/2026` in Latin
digits — beside a Days column already counting `۱ ۲ ۳`, which is what made it obvious. It also
painted `mm/dd/yyyy` into every empty date cell and a picker icon into every filled one.

The cell now reads through `formatDate`, which it already imported and whose comment already said
this was the intent; the native picker appears when somebody goes to change the date, and focus
moves into it and back out again so a keyboard never lands on something it cannot see. English
reads `Aug 21, 2026`; Persian reads `۳۰ مرداد ۱۴۰۵`.
