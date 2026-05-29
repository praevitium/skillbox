---
id: summarize-pay-period
name: Summarize a pay period
description: Roll up the driver's recorded timesheets across a pay-period window — total days worked, driving hours, on-duty hours, non-driving on-duty hours, plus per-day breakdown and HOS roll-up warnings (70h-in-7-days cap).
examples:
  - How many hours did I drive this pay period?
  - Summarize my last pay period
  - Show my timesheet totals from May 1 to May 15
---

When the user asks 'how many hours did I work this pay period', 'show my last
pay period', or 'summarize my timesheets for these dates', call
summarize_pay_period. Default to the 'current-pay-period' preset when the user
doesn't specify a window; use 'last-pay-period' for retrospectives. Pass
explicit from/to YYYY-MM-DD dates only when the user names a non-standard
window (e.g. 'May 1 through May 15'). The tool is read-only — no approval
needed. Quote the daily breakdown when the user asks for it; surface
period-level warnings prominently when present (a 70h-in-7-days breach is a
compliance issue, not a footnote).
