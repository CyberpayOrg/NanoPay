# CyberNanoPay — CLAUDE.md

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

If gstack skills aren't working, run `cd .claude/skills/gstack && ./setup` to rebuild.

Available skills:
- `/office-hours` — product direction brainstorming
- `/plan-ceo-review` — CEO-mode scope & strategy review
- `/plan-eng-review` — architecture, data flow, failure modes
- `/plan-design-review` — design review
- `/review` — pre-landing PR code review (SQL safety, trust boundaries, side effects)
- `/ship` — run tests, bump VERSION, update CHANGELOG, push PR
- `/qa` — browser-based QA automation
- `/cso` — Chief Security Officer audit (secrets, OWASP, STRIDE)
- `/investigate` — systematic root cause debugging
- `/retro` — weekly engineering retrospective
- `/careful` — extra-careful mode for risky changes
- `/guard` — guard mode
- `/browse` — web browsing
