# Publishing this repo

Five minutes, from a new terminal.

```sh
cd ~/Downloads/source-kit-open
git init
git add -A
git commit -m "Source Kit open provenance core (0.18.3)"
```

Create the GitHub repo and push. If you have the GitHub CLI:

```sh
gh auth login            # browser flow, once
gh repo create source-kit-open --public --source . --push
```

Without the CLI: github.com → New repository → name it `source-kit-open` →
**do not** add a README/license (we ship our own) → then:

```sh
git remote add origin https://github.com/<your-username>/source-kit-open.git
git branch -M main
git push -u origin main
```

## Before you push — two personal choices

1. **License holder.** `LICENSE` says "Source Kit contributors". Swap in your
   name if you'd rather hold it personally.
2. **README link.** The first line links to the app — update the URL once the
   App Store / TestFlight public link exists.

## Suggested repo description (GitHub "About" box)

> Open provenance core of the Source Kit camera: genuine C2PA Content
> Credentials, Secure Enclave signing, RFC 3161 timestamps, App Attest —
> with a runnable lab that reproduces every security claim.

## Good first issues to file (invites the conversation)

- Independent review of the PNG `caBX` embed vs. the C2PA 2.x spec
- Additional TSA endpoints / countersignature policy
- Android port of the provenance core (the crypto is platform-neutral TS)
- Verifier CLI: wrap `verifyAsset.ts` so `npx source-kit-open <file>` works
  without the iOS app
