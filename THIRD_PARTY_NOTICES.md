# Third-Party Notices and Attributions

RUNUT integrates writing quality guidelines and editorial standards adapted from the following open-source projects. Their respective licenses, copyright notices, and scopes of integration are preserved below. These notices apply to project documentation and are never inserted as watermarks or promotional text into user-downloaded documents.

---

## 1. Anti-AI-Slop (`dharmawan-id/anti-ai-slop`)
- **Repository:** https://github.com/dharmawan-id/anti-ai-slop
- **License:** MIT License
- **Copyright:** Copyright (c) 2026 Dharmawan
- **Scope in RUNUT:** Universal across all 7 writing profiles (`academic`, `professional`, `business`, `technical`, `marketing`, `corporate`, `general`), adapted contextually to each document's purpose in `server/src/services/prompts/antiAiSlop.js` and `server/src/services/prompts/writingEngine.js`.

## 2. Humanize Text (`rijans/agent-skills`)
- **Repository:** https://github.com/rijans/agent-skills (`skills/humanize-text`)
- **License:** MIT License
- **Copyright:** Copyright (c) 2026 Jaber Al Nahian
- **Scope in RUNUT:** Universal across all 7 writing profiles for author voice preservation, minimal-change editing discipline, natural sentence rhythm, and anti-fabrication principles in `server/src/services/prompts/humanizeText.js`.

## 3. Academic Writer & Research Writer (`drarunmitra/research-skills`)
- **Repository:** https://github.com/drarunmitra/research-skills (`academic-writer`, `research-writer`)
- **License:** Creative Commons Attribution 4.0 International (CC BY 4.0) — https://creativecommons.org/licenses/by/4.0/
- **Modifications:** Adapted into concise bilingual (Indonesian & English) prompt rules and strictly scoped to the `academic` writing profile only (`server/src/services/prompts/academicWriter.js` via `server/src/services/prompts/profiles/index.js`). Not applied to non-academic workplace, business, technical, marketing, corporate, or general documents.

---

*Note: RUNUT's multi-domain profile detector, professional/business/technical/marketing/corporate/general writing rules, document template preservation engine, similarity/citation engines, and two-phase token transaction system are original RUNUT implementations.*
