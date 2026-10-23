# Friction log

These are the real snags I hit while building Rewind. Each one covers what I was trying to do, what I did, what I expected versus what happened, how bad it was, how I got around it, and what would help.

Severity: **Critical** = blocked me · **High** = broke a core flow · **Medium** = cost me hours · **Low** = annoying.

---

### 1. AWS account locked during identity verification

- **Tool:** AWS account / identity verification (KYC)
- **Trying to:** create an access key for the `rewind-render` IAM user, so the live site could call Amazon Bedrock (Nova) and Amazon Polly.
- **What I did:**
  - Signed in to the console (a password reset first).
  - Created the IAM user.
  - Attached an inline policy for Nova Lite and Polly only.
  - Went to create the access key.
- **Expected:** to finish the key and switch on Nova and Polly on the live site.
- **What happened:** my account got locked for identity verification, and with the deadline close there wasn't time to get through review.
- **Severity:** Critical (for the AWS part)
- **Workaround:**
  - Kept the integration in the code: Bedrock planning, Polly voice, a least-privilege IAM policy, an AgentCore deployment guide.
  - Unit-tested it with mocked AWS clients.
  - Made the live site fall back cleanly: the deterministic planner and the browser's natural voices.
- **Suggestion:**
  - Show a clear status page: what's being checked, how long it usually takes, and what still works meanwhile.
  - For hackathon participants, offer a fast-track review or a sandbox account with Bedrock and Polly enabled.

### 2. Edge speech recognition never answers

- **Tool:** Web Speech API (`SpeechRecognition`) in Microsoft Edge
- **Trying to:** let people speak their request.
- **What I did:** created `webkitSpeechRecognition`, called `start()`, allowed the microphone, and talked.
- **Expected:** words as I spoke, a final result, then an end event.
- **What happened:** it starts, and then nothing: no result, no error, no end. My ring sat on "Listening…" forever. Headless tests couldn't catch it because they have no microphone.
- **Severity:** High
- **Workaround:**
  - A watchdog that switches engines if no audio starts in 4 seconds, or no result arrives 10 seconds after speech.
  - Edge, Firefox and Brave go straight to Whisper running on the device.
- **Suggestion:** always end a session with an error or end event when the service isn't available, and add a way to check availability up front.

### 3. Speech synthesis gets stuck after one reply on Windows voices

- **Tool:** `speechSynthesis` in Chrome and Edge, with Windows voices
- **Trying to:** speak "here's what I'm about to do", then the outcome when the run finishes.
- **What I did:** spoke the first reply (it finished fine), then spoke the second one about 15 seconds later.
- **Expected:** the second reply plays to the end.
- **What happened:** it starts, says a word or two, then freezes. The browser keeps saying it's speaking, and the end event never comes. The exact same sentence plays fine if I reset the engine and wait a moment first. I only found this by logging every speech event in the real browsers.
- **Severity:** High
- **Workaround:**
  - Reset the engine and pause 300 ms before each reply.
  - Speak each reply in one go.
  - Keep a reference to each utterance until it finishes.
  - Retry once if it never starts.
  - Hard time limits, so nothing can hang.
- **Suggestion:** fix the stall, or at least fire an error when it happens.

### 4. Transformers.js loads its runtime from a CDN

- **Tool:** Hugging Face Transformers.js 4 and ONNX Runtime Web
- **Trying to:** run Whisper in the browser on a site with a strict security policy (`script-src 'self'`).
- **What I did:** created a speech recognition `pipeline()` in a Web Worker.
- **Expected:** a documented way to host the runtime myself.
- **What happened:** by default the runtime files come from cdn.jsdelivr.net and get loaded through a `blob:` script, which a strict policy blocks.
- **Severity:** Medium
- **Workaround:**
  - Imported the runtime files through Vite and pointed `wasmPaths` at my own URLs.
  - Gave only the worker file its own looser policy.
- **Suggestion:** a documented mode that loads from configured same-origin URLs, and a list of the exact policy rules each feature needs.

### 5. Render Blueprint error didn't say what was wrong

- **Tool:** Render Blueprints
- **Trying to:** deploy `render.yaml` (a paid web service with a disk) from a private GitHub repo.
- **What I did:** connected a Git provider, chose New → Blueprint, and applied it.
- **Expected:** a review screen, or a clear error.
- **What happened:**
  - First, Render couldn't see the repo: I'd connected GitLab, but the repo was on GitHub.
  - Then it showed "A Blueprint file was found, but there was an issue". The real reasons were no payment card on file and an empty Blueprint name.
- **Severity:** Medium
- **Workaround:** connected GitHub, added a card, named the Blueprint, and retried.
- **Suggestion:** name the actual problem, and say which Git provider a repo needs.

### 6. Lockfile made on Windows broke the Linux build

- **Tool:** npm 11 with Vite 8
- **Trying to:** do the first deploy to Render (Linux) of a project I built on Windows.
- **What happened:** `npm ci` failed, saying a Linux binding was missing from the lockfile. An earlier fix had pinned the Windows-only package, so the lockfile only knew about Windows.
- **Severity:** Medium
- **Workaround:** removed the pin and rebuilt the lockfile from scratch, so it lists every platform.
- **Suggestion:** npm could warn when a lockfile only covers one platform's native packages.

### 7. Stateless MCP server shows a 405 in the console

- **Tool:** MCP TypeScript SDK v2 client, with a stateless Streamable HTTP server
- **What happened:** after connecting, the client opens a `GET /mcp` stream. My stateless server correctly answers 405, but the browser shows it as a red error, which looks like a bug.
- **Severity:** Low
- **Workaround:** documented it.
- **Suggestion:** let the client skip that stream for stateless servers.

### 8. Bedrock tool names can't have dots

- **Tool:** Amazon Bedrock Converse
- **What happened:** names like `thermostat.set_mode` aren't allowed; only letters, numbers, `_` and `-`.
- **Severity:** Low
- **Workaround:** a reversible mapping, `home-sim__thermostat__set_mode`.
- **Suggestion:** allow `.` and `:` to match MCP naming.

### 9. My landing page crashed phones

- **Tool:** CSS blur filters and blend modes on mobile browsers
- **What happened:** big blurred glows that resize as you scroll, a full-screen blend layer, and frosted-glass panels ran phones out of graphics memory, and the page crashed on scroll. Emulators didn't show it.
- **Severity:** High
- **Workaround:** rebuilt the visuals with gradients and SVG, with frosted glass on desktop only. Now there are zero slow frames scrolling on a phone emulator.
- **Suggestion:** a devtools warning for huge filter layers on mobile would have saved me.

### 10. New Render subdomain flickered at first

- **Tool:** Render
- **What happened:**
  - You can't rename the subdomain, so I created a new service.
  - For the first few minutes, about 1 in 4 requests came back as a 404 while routing caught up.
- **Severity:** Low
- **Workaround:** waited a few minutes.
- **Suggestion:** allow renaming, and show "routing is updating" in the dashboard.

### 11. Git sign-in window hid behind everything

- **Tool:** Git Credential Manager on Windows
- **What happened:** an old saved login failed, and the new sign-in window opened behind my other windows, so `git fetch` looked frozen.
- **Severity:** Low
- **Workaround:** switched to device-code sign-in (`GCM_GITHUB_AUTHMODES=device`).
- **Suggestion:** print a hint in the terminal while it's waiting.
