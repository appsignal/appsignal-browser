---
bump: patch
type: fix
---

Give a duplicated tab its own `tab_id` in every case. Each tab announces its id
once, when it starts, so the older tab's announce goes out before the duplicate
exists. Only the duplicate heard the collision, and it kept its copy of the id
whenever it held the smaller tag. Two tabs then reported the same `tab_id` for
the rest of the page, which merges their journeys.

The tab that keeps the id now answers the announce, so the other tab learns of
the collision and regenerates.
