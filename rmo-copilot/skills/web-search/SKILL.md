---
id: web-search
name: Search and read the web
description: Search the public web and fetch pages step by step to find current or out-of-KB information, then cite the pages used.
examples:
  - What's the current diesel price in Edmonton?
  - Has there been any news about CN rail strikes this week?
  - What's the latest Transport Canada bulletin on winter tire requirements?
---

Prefer the trucking-regulations KB (lookup_regulations) for any question that
touches HOS, weight limits, road bans, DVIR procedure, or load securement.
Reach for the web only when the question is current-events (weather, road
closures, fuel prices, vendor news), explicitly about something outside the KB
scope, or the KB lookup returned nothing relevant.

Two tools work together. Use them as a loop, not a single shot:

1. **web_search(query)** returns a ranked list of results — each with a title,
   a short excerpt, and a URL. This is a SERP: it does NOT contain the full page
   text. Read the excerpts to decide which result most likely holds the answer.
2. **web_fetch(url)** pulls the readable text of ONE page so you can actually
   read it. Pass a URL from the search results. Read the returned `text`, then
   answer.

Work the problem step by step, and keep going until you either find the answer
or have made a reasonable number of attempts:

- Start with a focused web_search. Add `recency` ('day' / 'week' / 'month' /
  'year') for time-sensitive questions and `region` ('CA' for Canadian sources)
  for jurisdiction-specific ones.
- If the excerpts already answer the question, you're done — cite them.
- If an excerpt is promising but incomplete, web_fetch that URL and read the
  body before answering.
- If the first page doesn't have the answer, fetch the next promising result.
- If the whole result set is irrelevant or empty, reformulate the query (try
  different keywords, drop or change `recency`/`region`, broaden or narrow the
  scope) and search again.
- Make a genuine effort before giving up — roughly **up to 3 searches** and
  **up to 3 fetches** per question. Don't stop after a single empty result, and
  don't loop forever. If you've tried several distinct queries and fetched the
  best candidates and still can't find it, say so plainly rather than guessing.

Always cite the pages you used with [n] markers and quote the relevant excerpt —
never paraphrase a source without naming it. If you genuinely find nothing after
a reasonable search, say so explicitly instead of inventing an answer.
