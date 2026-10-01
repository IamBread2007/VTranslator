# No hardcoded secrets
Source code must not contain passwords, API keys, tokens, or connection URLs with credentials.
Read them from the environment, a function parameter, or the config module.

# Comments explain why, not what
A comment states a reason, a constraint, a workaround, or a non-obvious invariant. A comment
that restates what the next line plainly does is a violation.

# Errors are not swallowed
A `catch` or `except` block must handle the error, report it, or re-raise it. An empty block,
one whose body is only `pass` or a comment, is a violation.

# No partial implementations
Implement features fully. A comment that says "for now", "simplified", or "later", or a
stub body, is a violation. If a part genuinely cannot be done, say so in your reply instead
of stubbing it.

# Do not run destructive commands that erase uncommitted work
`git reset --hard`, `git checkout -- .`, `git clean -fd`, and similar commands that discard
untracked or uncommitted changes are forbidden. These destroy work that has no backup. If a
clean tree is needed, create a worktree instead or ask the user.

# Secrets stay out of git and logs
`server/.env` must never be committed or printed. Log statements must not include the
`X-MT-Token` value, the LLM API key, request headers, or raw image bytes. Logging timing,
cache hits, sizes, and counts is fine.

# Every endpoint except health requires the token
paths: server/mt/app.py
Each FastAPI route other than `GET /health` must depend on the `X-MT-Token` auth check, and the
comparison must use `hmac.compare_digest`. A new route without the auth dependency is a violation.

# Server binds to localhost only
paths: server/mt/config.py, server/mt/__main__.py
The default host is `127.0.0.1`. Binding to `0.0.0.0` or a public interface by default is a
violation. CORS must stay restricted to `chrome-extension://` origins.

# Untrusted image input is bounded before decoding
paths: server/mt/app.py, server/mt/pipeline.py
Upload size is capped while reading, without trusting `Content-Length`. Width, height, and pixel
count are checked before `.convert("RGB")` or `.load()`. Oversize maps to HTTP 413, undecodable
input to 400.

# Style is measured on the original image
paths: server/mt/pipeline.py
Style estimation must run on the original page before inpainting. Passing an inpainted image to
the style estimator, or reordering inpaint before style, is a violation.

# Language detection uses script evidence, not cross-model scores
paths: server/mt/ocr.py, server/mt/pipeline.py
Source language is decided from Unicode script counts with evidence levels
`high`/`medium`/`low`/`explicit`. Comparing `rec_scores` between different OCR models as if they
were calibrated probabilities is a violation. An explicit `source_lang` must not load or run any
probe model.

# Auto-detection loads at most the planned models
paths: server/mt/ocr.py, server/mt/pipeline.py
`source_lang=auto` runs the primary `paddle:v5` probe, and the `paddle:korean` probe only when the
primary result is ambiguous. Loading extra Paddle language pipelines just to guess the language is
a violation.

# Heavy models load lazily
paths: server/mt/__main__.py, server/mt/ocr.py, server/mt/detector.py
Detector, OCR, and inpainting models load on first use, not at import or server startup. Engines
are cached by key and reused.

# Cache writes are atomic and corruption is a miss
paths: server/mt/cache.py
Cache files are written to a temp file then moved with `os.replace`. A missing PNG, invalid JSON,
or unreadable file must be treated as a cache miss, never raised to the request. Base64 PNG must
not be stored inside cache JSON.

# Cache keys include every input that changes the result
paths: server/mt/pipeline.py, server/mt/cache.py
Perception keys include the image hash, requested language, detector, OCR, style, inpainter config,
and `PIPELINE_VERSION`. Translation keys include the perception key, resolved language, target
language, LLM model, `PROMPT_VERSION`, and normalized `prev_context`. Changing prompt or pipeline
behavior without bumping the matching version is a violation.

# LLM errors are explicit and bounded
paths: server/mt/translator.py
Non-200 responses and network failures raise `TranslationError` with at most 200 characters of the
response body. Invalid JSON gets exactly one corrective retry. Model output is parsed with
`json.loads`, never `eval`.

# Missing translations are reported
paths: server/mt/pipeline.py
A block without a translation falls back to its source text and adds the warning
`missing translation for id N`. Silently dropping blocks is a violation.

# Dependencies are pinned
paths: server/requirements.txt, server/requirements.lock, extension/package.json
New dependencies use exact versions. Open ranges such as `>=` or `^` are a violation.

# No GPL code copied
Code must not be copied or closely adapted from `zyddnys/manga-image-translator` or other GPL-3.0
sources. Reimplement from documentation and model cards instead.

# Rendered fonts support Vietnamese
paths: extension/**
Fonts used to render translations must cover Vietnamese diacritics. Use Patrick Hand, Bangers, or
Be Vietnam Pro, mapped from the `dialogue`, `shout`, and `narration` styles.

# Tests use fakes, production code does not know them
paths: server/mt/**
Production modules must not import from `tests/` or branch on test-only components. Fakes are
injected through constructor parameters or protocols.

# Model-backed tests are marked slow
paths: server/tests/**
A test that downloads or runs a real model (detector, PaddleOCR, manga-ocr, LaMa) must carry
`pytest.mark.slow`, so `pytest -m "not slow"` stays fast and offline.

# Test fixtures are self-made or licensed
paths: server/tests/fixtures/**
Fixture images must be generated by the project or come from a source whose license allows use.
Scanned pages from commercial manga are a violation.

# Python code passes ruff
paths: server/**/*.py
Python files must pass `ruff check` and `ruff format --check`. Suppressing a rule with `noqa`
needs a comment that says why.
