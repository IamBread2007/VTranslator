# Manga Translator

Translate the manga pages already open in a tab, one at a time, with the
previous page's lines carried forward as context.

## Running it

The extension needs the local server, because the page's images are never sent to
a third party by the extension itself.

```bash
cd server && .venv\Scripts\python -m mt
cd extension && npm run build
```

Then load `extension/dist/` as an unpacked extension.

## Chapter runs

Press **Alt+T** to translate the chapter. The extension works through the pages
in reading order and never moves the page you are looking at: it does not scroll,
click, turn, or navigate. If you want to see a later page, you scroll to it.

Before it spends anything, a run asks how much it may cost:

- **Consent threshold** (default 10): if more than this many pages are found, you
  are asked before the first page is translated. Under the threshold the run
  starts without asking.
- **Page cap** (default 60): a run stops at the cap. Pages beyond it are not
  translated and not billed. The summary says the cap was reached and does not
  claim the chapter was finished, because it was not.

Both are in Settings. Lower the threshold if you would rather be asked more
often; lower the cap if you want a hard ceiling on a single run.

Consent is cumulative and can be given again mid-run: approving ten more pages at
a second prompt authorises ten more, not ten in total.

## Stopping

Press **Alt+S**, or click the **Dừng** button while a run is in progress. Stop is
scoped to the tab and the run, so stopping one tab never interrupts another.

What Stop does:

- pages already translated stay translated;
- the page being translated when you pressed Stop is reverted to the original;
- pages not yet started are not started;
- the request to the model provider is cancelled.

That last point has a limit worth stating plainly. Stop ends the request to the
provider, so it stops generating further output. **Tokens the provider had already
produced before the cancellation arrived are still billed.** Stopping saves the
remainder of a page, not the part already spent.

Cancellation cannot interrupt local image processing that is already running on
the CPU; the run notices the Stop as soon as that finishes. Translation itself, the
expensive part, is cancelled promptly.

## What the summary claims

The run reports pages **found**, not pages assumed. If the reader only built part
of the chapter while you were looking at it, the summary says how many pages were
found. It never claims to have translated a whole chapter that it did not verify
end to end.

## Tests

```bash
npm run typecheck
npx vitest run                    # unit
npm run test:integration          # headed Chromium, local fixtures only
```

The integration suite uses fixture readers and a local stub server. It needs a
display; Chrome refuses `--load-extension` in headless.

### Real-reader smoke tests

Everything above runs against fixtures, and a fixture cannot tell you that a real
reader still works. The smoke tests can, and they are opt-in because they are the
only tests that touch the network:

```bash
MT_SMOKE=1 npx vitest run --config vitest.integration.config.ts tests/integration/smoke.test.ts
```

Each reader is reported as `passed`, `failed` or `untested`. A reader that cannot
be reached — a login wall, a challenge, a region block — reports `untested`, never
`passed`. An unreachable site is not evidence that the feature works.