# Contributing to Pi Agent Chatbot Platform

Thank you for your interest in contributing! This guide explains how to submit a pull request (PR) from your fork of this repository to the original upstream repository.

## Prerequisites

- A [GitHub](https://github.com) account
- [Git](https://git-scm.com/) installed locally
- Node.js 20+ and Docker (see [README](README.md) for the full setup)

---

## Step 1 — Fork the original repository

1. Navigate to the **upstream (original)** repository on GitHub:
   `https://github.com/ianshan0915/pi-agent-chatbot-platform`
2. Click the **Fork** button (top-right corner).
3. GitHub creates a personal copy under your account, e.g.  
   `https://github.com/<your-username>/pi-agent-chatbot-platform`

---

## Step 2 — Clone your fork locally

```bash
git clone https://github.com/<your-username>/pi-agent-chatbot-platform.git
cd pi-agent-chatbot-platform
```

---

## Step 3 — Add the upstream remote

Connecting your local clone to the **original** repository lets you pull in future changes easily:

```bash
git remote add upstream https://github.com/ianshan0915/pi-agent-chatbot-platform.git
# Verify both remotes exist
git remote -v
# origin    https://github.com/<your-username>/pi-agent-chatbot-platform (fetch)
# origin    https://github.com/<your-username>/pi-agent-chatbot-platform (push)
# upstream  https://github.com/ianshan0915/pi-agent-chatbot-platform (fetch)
# upstream  https://github.com/ianshan0915/pi-agent-chatbot-platform (push)
```

---

## Step 4 — Sync your fork with upstream (before starting work)

Always start from an up-to-date `main` branch to minimize merge conflicts:

```bash
git fetch upstream
git checkout main
git merge upstream/main   # or: git rebase upstream/main
git push origin main      # keep your fork's main in sync
```

---

## Step 5 — Create a feature branch

Never commit directly to `main`. Create a descriptive branch for your change:

```bash
git checkout -b feat/my-feature   # or fix/bug-name, docs/update-readme, etc.
```

---

## Step 6 — Make your changes

Follow the project's setup instructions in [README.md](README.md):

```bash
npm install
docker compose -f docker-compose.dev.yml up -d
npm run dev
```

Edit files, then type-check your work:

```bash
npm run check   # TypeScript type checking
npm run build   # Ensure the production build still compiles
```

---

## Step 7 — Commit your changes

Use clear, descriptive commit messages:

```bash
git add .
git commit -m "feat: add X feature" # or "fix: correct Y behavior"
```

Commit message conventions (optional but appreciated):

| Prefix | When to use |
|--------|-------------|
| `feat` | New feature |
| `fix`  | Bug fix |
| `docs` | Documentation only |
| `chore`| Build / tooling changes |
| `refactor` | Code restructuring without behavior change |

---

## Step 8 — Push your branch to your fork

```bash
git push origin feat/my-feature
```

---

## Step 9 — Open a Pull Request on GitHub

1. Go to **your fork** on GitHub:  
   `https://github.com/<your-username>/pi-agent-chatbot-platform`
2. GitHub will show a banner: **"Compare & pull request"** — click it.  
   If the banner is gone, click **Contribute → Open pull request**.
3. Make sure the **base repository** is the **upstream** repo  
   (`ianshan0915/pi-agent-chatbot-platform`, branch `main`)  
   and the **head repository** is your fork and feature branch.
4. Fill in:
   - A clear **title** summarising the change.
   - A **description** explaining *what* changed and *why*.
   - Reference any related issues with `Closes #<issue-number>`.
5. Click **Create pull request**.

---

## Step 10 — Respond to review feedback

The maintainers may request changes. Push additional commits to the **same branch** — the PR updates automatically:

```bash
# make edits…
git add .
git commit -m "fix: address review feedback"
git push origin feat/my-feature
```

---

## Keeping your fork up to date over time

If `upstream/main` has moved on while your PR is open, rebase to avoid conflicts:

```bash
git fetch upstream
git rebase upstream/main
git push --force-with-lease origin feat/my-feature
```

---

## Code style

- TypeScript strict mode — run `npm run check` before opening a PR.
- Match the existing code style; no linter changes needed.
- Keep PRs focused — one concern per PR makes review easier.

---

## Questions?

Open a [GitHub Issue](https://github.com/ianshan0915/pi-agent-chatbot-platform/issues) on the upstream repository if you have questions or want to discuss a change before implementing it.
