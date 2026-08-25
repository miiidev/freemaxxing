# Manual smoke checklist (run before calling any release done)

Prereq: valid keys for all six providers exported in the shell or ~/.maxout/.env.

1. `npm run build && node dist/cli.js serve`
   - Expect banner: `maxout serving 6/6 providers on http://127.0.0.1:8787/v1`
2. `node dist/cli.js status`
   - Expect one row per registry entry for keyed providers; all `ok`.
3. Non-streaming happy path:
   curl http://127.0.0.1:8787/v1/chat/completions -H "content-type: application/json" ^
     -d "{\"model\":\"auto/coding\",\"messages\":[{\"role\":\"user\",\"content\":\"say hi in 3 words\"}]}"
   - Expect 200 JSON, `model` starts with `<provider>::`, header `x-maxout-served-by` present.
4. Streaming happy path: same body + `"stream":true`
   - Expect SSE frames, each frame's `model` field rewritten to served id, final `data: [DONE]`.
5. Failover drill: exhaust one provider deliberately (tiny daily-limit provider first),
   re-run step 3 repeatedly until the log shows `tried=<id>(quota)` and a different
   provider serves. Then `node dist/cli.js status` shows the exhausted row.
6. Restart persistence: restart the server, confirm step 5's exhausted model is still
   skipped (state snapshot survived) and recovers after UTC midnight.
7. Unknown alias returns 404 shape; missing messages returns 400 shape.
8. Confirm no log line ever contains an API key value.

## Setup wizard — zero-key-user acceptance

1. Temporarily hide any real keys: `$env:GROQ_API_KEY=$null` etc.; ensure `%USERPROFILE%\.maxout\.env` does not exist.
2. `node dist/cli.js setup` — accept the Groq recommendation (Enter).
3. Browser opens console.groq.com/keys (or copy the printed URL); create a key; paste it.
4. Expect `saved GROQ_API_KEY`; answer `N` to all bonus providers.
5. `node dist/cli.js serve` → POST a tools request to `http://127.0.0.1:8787/v1/chat/completions` with `model:"auto/coding"`.
6. Expect HTTP 200, `x-maxout-served-by` starting `groq::`.
7. `node dist/cli.js status` shows `1/6 providers have keys` and groq rows only.
