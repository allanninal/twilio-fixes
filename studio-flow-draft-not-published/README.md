# a Studio Flow left in draft, so your edits are live nowhere

Someone opened the Flow, moved a widget, changed the greeting, saved, and tested it from their own handset. It worked. Two weeks later a customer quotes the old greeting back at you. Nothing failed, nothing was rolled back, and the Console still shows the new version exactly as it was left &mdash; because the Console shows the draft, and every real caller is running the last revision somebody pressed Publish on.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/studio-flow-draft-not-published/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_studio_draft_audit.py
node node/twilio-studio-draft-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_studio_draft_audit.py
node --test node/twilio-studio-draft-audit.test.mjs
```
