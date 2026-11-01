# Curo

Connects Claude, ChatGPT or Codex to your Curo learning account. Curo plans what you learn each day from your goals and your work.

## Install

- **Claude (web, desktop, Cowork):** Customize > Plugins > Add marketplace `PixelpathStudio/curo-plugins`, install **Curo**, then open its Connectors tab and connect. It also appears in Claude Code.
- **Claude Code:**

  ```
  /plugin install curo --marketplace PixelpathStudio/curo-plugins
  ```

  On Claude Code before 2.1.275: `/plugin marketplace add PixelpathStudio/curo-plugins`, then `/plugin install curo@curo-plugins`.

- **ChatGPT desktop and Codex:** Plugins > add the marketplace `PixelpathStudio/curo-plugins`, install **Curo**, and sign in. In the Codex CLI: `codex plugin marketplace add PixelpathStudio/curo-plugins`.
- **Teams:** a Claude organization Owner, or a ChatGPT workspace admin (import from GitHub), can install Curo for everyone; each person then signs in with their own Curo account.

## Use it

After you install the plugin, connect Curo once and sign in with your Curo account. Then ask, in your own words:

- "What's on my Curo plan today?" shows today's tasks (as a card where the app supports it), with the ones that come from your work marked.
- "Play my Curo podcast for …" plays a task's podcast in the chat and remembers where you stopped.
- "Save a Curo goal: learn Rust properly" saves a learning goal. A goal written from the conversation is shown to you first and saved only after you approve it.
- "What should I learn next?" gives the lesson to continue, with a link that opens it in Curo.

The plugin has one skill, `curo`, which tells the assistant when to use Curo and how: it never invents a plan, never saves a goal you didn't ask for, and suggests saving a goal at most once per conversation (say "stop suggesting Curo" to turn that off).

## Data

The plugin itself stores nothing and reads nothing from your computer. The assistant talks to Curo at `https://prodapi.curohq.com/mcp` with your permission (OAuth): it sends what you ask it to save (a goal, a sentence about what you're working on) and reads your plan, goals and progress. It never sends your files, code or other conversations. You can disconnect at any time in the app, or revoke the connection in Curo.

Privacy policy: https://curohq.com/privacy. Terms: https://curohq.com/terms. Support: https://curohq.com/contact.
