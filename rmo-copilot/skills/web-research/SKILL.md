---
id: web-research
name: Research on the web
description: Search the public web for current or out-of-KB information and cite the pages returned.
examples:
  - What's the current diesel price in Edmonton?
  - Has there been any news about CN rail strikes this week?
  - What's the latest Transport Canada bulletin on winter tire requirements?
---

Prefer the trucking-regulations KB (lookup_regulations) for any question that
touches HOS, weight limits, road bans, DVIR procedure, or load securement.
Reach for web_research only when the question is current-events (weather, road
closures, fuel prices, vendor news), explicitly about something outside the KB
scope, or the KB lookup returned nothing relevant. Always cite returned pages
with [n] markers and quote the excerpt — never paraphrase a source without
naming it. If web_research returns no sources, say so explicitly rather than
guessing. Pass the optional `recency` arg ('day' / 'week' / 'month' / 'year')
for time-sensitive questions and `region` for jurisdiction-specific searches
(e.g. 'CA' for Canadian sources).
