# Testing instructions

You don't need an account, keys or any installs. Everything runs on a pretend smart home, so nothing real gets touched.

**Live site:** https://getrewind.onrender.com

## 1. The one-minute version

1. Open the site and scroll down to **Say it. Watch it fail. Watch it rewind.**
2. Type a request, for example *"Turn the heat down to 18, remind me to water the plants, then lock up the house."* Or tap the light ring and say it out loud (allow the microphone when your browser asks).
3. Under the box you'll see the steps Rewind is about to run. The last one is marked "will fail", on purpose.
4. Press **Run it**. You'll land in the agent demo, in your own temporary guest workspace.
5. Watch it play out:
   - a real MCP agent runs each step, and the assistant says what it's doing;
   - the last step fails;
   - Rewind undoes the earlier steps, newest first, and checks each one;
   - you get **Recovered · verified**, read out loud.
6. Click **Open inspector** to see every event, snapshot and before/after diff.

## 2. Three things worth trying

These are the **Try:** buttons in the demo:

| Button | What happens |
| --- | --- |
| **Weekend away** | Thermostat, task list, then the security routine. The routine fails; the other two get put back and verified. |
| **Tell the family** | The message waits for your approval right there. Approve it and the agent carries on, the last step fails, and Rewind says *partially recovered*, because a sent message can't be unsent. |
| **Try something risky** | "Disarm the alarm" is blocked by policy before anything runs. |

The **Recovery playground** on the landing page lets you choose which step fails, swap in a timeout, add an irreversible text, or have a family member edit the list mid-run. In that last case Rewind refuses to overwrite their change.

## 3. Connecting your own agent over MCP (optional)

1. In the console, go to **Settings → API keys → Create key** and copy the `rwk_…` key.
2. Add the server to your MCP client. With Claude Code:

   ```bash
   claude mcp add --transport http rewind https://getrewind.onrender.com/mcp --header "Authorization: Bearer rwk_YOUR_KEY"
   ```

   In the MCP Inspector, pick **Streamable HTTP**, use the URL above, and add the header `Authorization: Bearer rwk_…`.
3. Ask your agent to list operations, open an execution and run steps. To see a full failure and recovery, clone the repo and run:

   ```bash
   REWIND_API_KEY=rwk_… npm run demo:mcp -- --url https://getrewind.onrender.com/mcp
   ```

   That sets up a failure, runs three steps over MCP and prints the verified recovery.

The server speaks MCP 2025-11-25 over stateless Streamable HTTP and has 11 tools:

`list_operations`, `create_execution`, `execute_registered_action`, `run_execution`, `complete_execution`, `get_execution`, `list_executions`, `get_execution_trace`, `request_recovery`, `get_recovery_status`, `get_resource_state`

No MCP tool can approve an action; approvals only happen in the console.

## 4. About the voice

- **Speech in:**
  - Chrome and Safari use the browser's own recognition.
  - Edge, Firefox and Brave use Whisper on your device. The first time, it downloads about 40 MB of model files, then they're cached.
  - Your audio never leaves your computer.
- **Speech out:** your browser's best natural voice. Edge's "Natural" voices sound best. The demo shows which voice it picked, and **Speak replies** turns it off. Amazon Polly is wired in too, but it's off on the live site because my AWS account was locked during identity verification.

## 5. Running it locally (optional)

You'll need Node.js 24.

```bash
git clone https://github.com/antonettesk/rewind && cd rewind
npm ci && npm run build && npm start
# then open http://127.0.0.1:4747
```
