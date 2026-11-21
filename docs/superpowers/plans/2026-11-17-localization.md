# English and Russian localization

User requirement: provide EN/RU versions of the site and description, with English first.

Implementation in the existing checkout; no commits or deployment requested.

- Add a small shared translation module and EN/RU selector. English is the first-visit default regardless of browser locale; persist explicit selection with graceful storage fallback.
- Translate static content, accessibility labels, page metadata, dynamic UI, dates, numbers, media states and known server errors. Switch in place without restarting media or clearing forms. Preserve user-provided names and unknown external errors.
- Keep README.md in English and the equivalent Russian description in README.ru.md, with reciprocal links.
- Verify language defaults, persistence, blocked storage, live switching, guest access and errors. Run existing JS/Go checks and browser regressions. Review the integrated changes.

Use local catalogs with the existing buildless JS app; an additional i18n framework or duplicated app pages would add unnecessary dependencies and maintenance.

## Verification

- 209 JavaScript checks pass (`npm test`, Node 25); translation parameters and nested microphone diagnostics are covered.
- `go test ./...` passes; final embedded application builds successfully.
- Admin-code browser run: 32 passed, 4 multi-user-only cases skipped. Multi-user auth: all 12 passed. Shared-room scenario passes separately; the combined run exhausted the intentional registration rate limit, so the isolated test server was restarted for that scenario.
- New browser cases verify English with a Russian browser locale, persistence, unavailable storage, existing server-error translation, mobile width, live media continuity, settings, user names and guest access.
- Independent review complete; its invalid test input and nested-message translation findings are fixed. Both language versions inspected in the browser. `git diff --check` passes.
